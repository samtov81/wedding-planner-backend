import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { crearEventoPublicado } from '../support/eventos'

interface Asiento {
  index: number
  occupant: { guestId: string; companionIndex: number; sobrante: boolean } | null
}
interface MesaApi {
  id: string
  name: string
  minSeats: number
  maxSeats: number
  seatCount: number
  x: number
  y: number
  seats: Asiento[]
}

/** Contra el servidor real: se comprueba que los guards están enganchados en cada ruta. */
describe('Distribución de mesas e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let planner: { id: string; accessToken: string }
  let extrano: { id: string; accessToken: string }
  let fotografo: { id: string; accessToken: string }
  let evento: string

  async function registrarYEntrar(
    email: string,
    fullName: string,
  ): Promise<{ id: string; accessToken: string }> {
    const registro = await request(url)
      .post('/auth/register')
      .send({ email, password: 'una-contraseña-larga', fullName })
      .expect(201)
    await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } })
    const login = await request(url)
      .post('/auth/login')
      .send({ email, password: 'una-contraseña-larga' })
      .expect(200)
    return {
      id: (registro.body as { id: string }).id,
      accessToken: (login.body as { accessToken: string }).accessToken,
    }
  }

  const como = (quien: { accessToken: string }) => ({
    Authorization: `Bearer ${quien.accessToken}`,
  })

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    ana = await registrarYEntrar('ana-mesas@test.com', 'Ana')
    planner = await registrarYEntrar('planner-mesas@test.com', 'Planner')
    extrano = await registrarYEntrar('extrano-mesas@test.com', 'Extraño')
    fotografo = await registrarYEntrar('foto-mesas@test.com', 'Fotógrafo')
    evento = await crearEventoPublicado(url, ana.accessToken, 'Boda de Ana')

    await prisma.eventMembership.create({
      data: { eventId: evento, userId: planner.id, role: 'PLANNER', status: 'ACTIVE' },
    })
    const perfil = await prisma.vendorProfile.create({
      data: { userId: fotografo.id, businessName: 'Luz', category: 'Photo', status: 'PUBLISHED' },
    })
    await prisma.eventVendor.create({
      data: { eventId: evento, vendorProfileId: perfil.id, category: 'Photo', status: 'BOOKED' },
    })
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('flujo completo: generar, crecer, sentar, intercambiar, sobrante, eliminar', async () => {
    const base = `/events/${evento}/seating`
    const invitadoA = await prisma.guest.create({
      data: {
        eventId: evento,
        name: 'Ana Invitada',
        group: 'Family',
        rsvp: 'CONFIRMED',
        companionsAllowed: 1,
        companionsConfirmed: 1,
      },
    })
    const invitadoB = await prisma.guest.create({
      data: { eventId: evento, name: 'Luis', group: 'Friends' },
    })

    const generado = await request(url)
      .post(`${base}/tables/generate`)
      .set(como(ana))
      .send({ count: 2, minSeats: 2, maxSeats: 4 })
      .expect(201)
    const [m1, m2] = (generado.body as { tables: MesaApi[] }).tables
    if (m1 === undefined || m2 === undefined) throw new Error('faltan mesas')
    expect([m1.name, m2.name, m1.seats.length]).toEqual(['Mesa 1', 'Mesa 2', 2])

    const crecida = await request(url)
      .patch(`${base}/tables/${m1.id}`)
      .set(como(planner))
      .send({ seatCount: 3, name: 'Novios', x: 300, y: 120 })
      .expect(200)
    expect(crecida.body).toMatchObject({ name: 'Novios', seatCount: 3, x: 300, y: 120 })

    const sentar = (tableId: string, seatIndex: number, guestId: string, companionIndex: number) =>
      request(url)
        .put(`${base}/assignments`)
        .set(como(ana))
        .send({ tableId, seatIndex, guestId, companionIndex })

    await sentar(m1.id, 0, invitadoA.id, 0).expect(200)
    await sentar(m1.id, 1, invitadoA.id, 1).expect(200)
    await sentar(m2.id, 0, invitadoB.id, 0).expect(200)
    await sentar(m1.id, 1, invitadoA.id, 2).expect(422)
    await sentar(m1.id, 3, invitadoB.id, 0).expect(422)

    const intercambio = await sentar(m2.id, 0, invitadoA.id, 0).expect(200)
    const tablas = (intercambio.body as { tables: MesaApi[] }).tables
    expect(tablas[0]?.seats[0]?.occupant).toEqual({
      guestId: invitadoB.id,
      companionIndex: 0,
      sobrante: false,
    })
    expect(tablas[1]?.seats[0]?.occupant?.guestId).toBe(invitadoA.id)

    // Quitar el último asiento con alguien sentado → 409.
    await sentar(m1.id, 2, invitadoA.id, 1).expect(200)
    await request(url)
      .patch(`${base}/tables/${m1.id}`)
      .set(como(ana))
      .send({ seatCount: 2 })
      .expect(409)

    await prisma.guest.update({
      where: { id: invitadoA.id },
      data: { rsvp: 'DECLINED', companionsConfirmed: 0 },
    })
    const leida = await request(url).get(base).set(como(ana)).expect(200)
    const sobrantes = (leida.body as { tables: MesaApi[] }).tables
      .flatMap((m) => m.seats)
      .filter((s) => s.occupant?.sobrante === true)
    expect(sobrantes).toHaveLength(2)

    await request(url).delete(`${base}/tables/${m1.id}/seats/2`).set(como(ana)).expect(204)
    await request(url).delete(`${base}/tables/${m2.id}`).set(como(ana)).expect(204)
    await request(url).delete(`${base}/tables/${m2.id}`).set(como(ana)).expect(404)
    expect(await prisma.seatAssignment.count({ where: { eventId: evento } })).toBe(1)
  })

  it('sin token → 401; extraño → 404; id no UUID → 404; PATCH vacío → 400', async () => {
    const base = `/events/${evento}/seating`
    await request(url).get(base).expect(401)
    await request(url).get(base).set(como(extrano)).expect(404)
    await request(url)
      .patch(`${base}/tables/no-uuid`)
      .set(como(ana))
      .send({ name: 'X' })
      .expect(404)
    const creada = await request(url)
      .post(`${base}/tables`)
      .set(como(ana))
      .send({ minSeats: 2, maxSeats: 4 })
      .expect(201)
    await request(url)
      .patch(`${base}/tables/${(creada.body as MesaApi).id}`)
      .set(como(ana))
      .send({})
      .expect(400)
    await request(url)
      .post(`${base}/tables`)
      .set(como(ana))
      .send({ minSeats: 5, maxSeats: 4 })
      .expect(400)
  })

  it('un vendor BOOKED recibe 403 en cada ruta', async () => {
    const base = `/events/${evento}/seating`
    const mesa = '00000000-0000-4000-8000-000000000000'
    const rutas = [
      request(url).get(base),
      request(url).post(`${base}/tables/generate`).send({ count: 1, minSeats: 1, maxSeats: 1 }),
      request(url).post(`${base}/tables`).send({ minSeats: 1, maxSeats: 1 }),
      request(url).patch(`${base}/tables/${mesa}`).send({ name: 'X' }),
      request(url).delete(`${base}/tables/${mesa}`),
      request(url).delete(`${base}/tables/${mesa}/seats/0`),
      request(url)
        .put(`${base}/assignments`)
        .send({ tableId: mesa, seatIndex: 0, guestId: mesa, companionIndex: 0 }),
    ]
    for (const ruta of rutas) await ruta.set(como(fotografo)).expect(403)
  })
})
