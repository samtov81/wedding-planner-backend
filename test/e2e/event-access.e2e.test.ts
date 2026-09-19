import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'

interface CuerpoError {
  code: string
  message: string
}

interface CuerpoEvento {
  id: string
  name: string
}

const INVENTADO = '00000000-0000-4000-8000-000000000000'

describe('Acceso a eventos e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let pedro: { id: string; accessToken: string }
  let extrano: { id: string; accessToken: string }
  let eventoDeAna: string
  let eventoDePedro: string

  async function registrarYEntrar(
    email: string,
    fullName: string,
  ): Promise<{ id: string; accessToken: string }> {
    const registro = await request(url)
      .post('/auth/register')
      .send({ email, password: 'una-contraseña-larga', fullName })
      .expect(201)

    const login = await request(url)
      .post('/auth/login')
      .send({ email, password: 'una-contraseña-larga' })
      .expect(200)

    return {
      id: (registro.body as { id: string }).id,
      accessToken: (login.body as { accessToken: string }).accessToken,
    }
  }

  async function crearEvento(accessToken: string, name: string): Promise<string> {
    const respuesta = await request(url)
      .post('/events')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name, weddingDate: '2027-06-12T00:00:00.000Z' })
      .expect(201)
    return (respuesta.body as CuerpoEvento).id
  }

  async function listarEventos(accessToken: string): Promise<string[]> {
    const respuesta = await request(url)
      .get('/events')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
    return (respuesta.body as CuerpoEvento[]).map((e) => e.id).sort()
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    ana = await registrarYEntrar('ana@test.com', 'Ana')
    pedro = await registrarYEntrar('pedro@test.com', 'Pedro')
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')

    eventoDeAna = await crearEvento(ana.accessToken, 'Boda de Ana')
    eventoDePedro = await crearEvento(pedro.accessToken, 'Boda de Pedro')
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('quien crea el evento entra: el evento y su membresía nacen juntos', async () => {
    const respuesta = await request(url)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    expect(respuesta.body).toMatchObject({
      id: eventoDeAna,
      name: 'Boda de Ana',
      access: { kind: 'member', role: 'COUPLE' },
    })
  })

  it('un usuario sin acceso recibe 404, no 403', async () => {
    const respuesta = await request(url)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)

    // El cuerpo no debe distinguirse del de un evento que no existe.
    const inventado = await request(url)
      .get(`/events/${INVENTADO}`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe((inventado.body as CuerpoError).code)
    expect((respuesta.body as CuerpoError).message).toBe((inventado.body as CuerpoError).message)
  })

  it('un id que ni siquiera es un UUID responde igual: 404, no 500', async () => {
    const respuesta = await request(url)
      .get('/events/no-es-un-uuid')
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('NOT_FOUND')
  })

  it('sin token no se llega ni a saber si el evento existe', async () => {
    await request(url).get(`/events/${eventoDeAna}`).expect(401)
  })

  it('invitar deja la membresía en INVITED, y una invitación sin aceptar no abre nada', async () => {
    await request(url)
      .post(`/events/${eventoDeAna}/members`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ email: 'pedro@test.com', role: 'PLANNER' })
      .expect(201)

    const membresia = await prisma.eventMembership.findUnique({
      where: { eventId_userId: { eventId: eventoDeAna, userId: pedro.id } },
    })
    expect(membresia).toMatchObject({ role: 'PLANNER', status: 'INVITED' })

    // Invitado pero no aceptado: sigue siendo 404, el mismo que para un extraño.
    await request(url)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${pedro.accessToken}`)
      .expect(404)

    // Y tampoco asoma en el listado: `GET /events` vuelve a expresar la regla
    // de acceso por su cuenta (un WHERE de Postgres, no el servicio), así que
    // hay que fijar aquí que INVITED queda fuera también por ese camino.
    expect(await listarEventos(pedro.accessToken)).toEqual([eventoDePedro])

    // Y quedó rastro de quién invitó a quién.
    const auditoria = await prisma.auditLog.findMany({ where: { eventId: eventoDeAna } })
    expect(auditoria).toHaveLength(1)
    expect(auditoria[0]).toMatchObject({
      actorUserId: ana.id,
      action: 'event.member.invited',
      target: `user:${pedro.id}`,
    })
  })

  it('un planner activo entra al evento, pero NO puede invitar: ahí sí es 403', async () => {
    // No existe todavía el endpoint para aceptar una invitación (es de una
    // tarea posterior), así que la aceptación se simula escribiendo la fila.
    await prisma.eventMembership.update({
      where: { eventId_userId: { eventId: eventoDeAna, userId: pedro.id } },
      data: { status: 'ACTIVE' },
    })

    await request(url)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${pedro.accessToken}`)
      .expect(200)

    // 403 y no 404: Pedro YA sabe que el evento existe, así que negarle esta
    // operación concreta no le revela nada que no tuviera.
    const negado = await request(url)
      .post(`/events/${eventoDeAna}/members`)
      .set('Authorization', `Bearer ${pedro.accessToken}`)
      .send({ email: 'extrano@test.com', role: 'PLANNER' })
      .expect(403)

    expect((negado.body as CuerpoError).code).toBe('FORBIDDEN')
  })

  it('cada quien ve en su lista sólo los eventos a los que tiene acceso', async () => {
    const deAna = await request(url)
      .get('/events')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    const dePedro = await request(url)
      .get('/events')
      .set('Authorization', `Bearer ${pedro.accessToken}`)
      .expect(200)

    const deExtrano = await request(url)
      .get('/events')
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(200)

    expect((deAna.body as CuerpoEvento[]).map((e) => e.id)).toEqual([eventoDeAna])
    // Pedro es COUPLE del suyo y PLANNER ya activo en el de Ana.
    expect((dePedro.body as CuerpoEvento[]).map((e) => e.id).sort()).toEqual(
      [eventoDeAna, eventoDePedro].sort(),
    )
    expect(deExtrano.body).toEqual([])
  })

  it('un vendor sólo entra cuando la contratación está BOOKED', async () => {
    const perfil = await prisma.vendorProfile.create({
      data: { userId: extrano.id, businessName: 'Lumière', category: 'Catering' },
    })
    const contratacion = await prisma.eventVendor.create({
      data: { eventId: eventoDeAna, vendorProfileId: perfil.id, category: 'Catering' },
    })

    // SHORTLISTED: todavía no es nadie en este evento.
    await request(url)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)
    expect(await listarEventos(extrano.accessToken)).toEqual([])

    await prisma.eventVendor.update({
      where: { id: contratacion.id },
      data: { status: 'BOOKED' },
    })

    const respuesta = await request(url)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(200)
    expect(respuesta.body).toMatchObject({
      access: { kind: 'vendor', eventVendorId: contratacion.id },
    })
    // Y ahora SÍ aparece en su listado: si la lista y el acceso a un evento
    // suelto divergieran, un vendor vería un evento que al abrirlo da 404.
    expect(await listarEventos(extrano.accessToken)).toEqual([eventoDeAna])

    // Pero un vendor no invita a nadie: tiene acceso, no mando.
    await request(url)
      .post(`/events/${eventoDeAna}/members`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .send({ email: 'pedro@test.com', role: 'PLANNER' })
      .expect(403)
  })

  /**
   * DEBE SER EL ÚLTIMO: revoca la membresía de Pedro, y este fichero comparte
   * estado entre tests en el orden en que están escritos.
   */
  it('revocar cierra las dos puertas: el evento suelto y el listado', async () => {
    expect(await listarEventos(pedro.accessToken)).toEqual([eventoDeAna, eventoDePedro].sort())

    await prisma.eventMembership.update({
      where: { eventId_userId: { eventId: eventoDeAna, userId: pedro.id } },
      data: { status: 'REVOKED' },
    })

    await request(url)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${pedro.accessToken}`)
      .expect(404)
    expect(await listarEventos(pedro.accessToken)).toEqual([eventoDePedro])
  })
})
