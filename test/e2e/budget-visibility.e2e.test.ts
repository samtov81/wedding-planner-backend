import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { categoriaId } from '../support/categorias'
import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { crearEventoPublicado } from '../support/eventos'

/**
 * e2e de la privacidad del presupuesto: sólo la creadora del evento (y el
 * admin) tiene `BUDGET_VIEW`/`BUDGET_EDIT`. Quien está en el evento sin ese
 * permiso recibe 403; quien no está, 404.
 */
describe('Visibilidad del presupuesto e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let luis: { id: string; accessToken: string }
  let pia: { id: string; accessToken: string }
  let dj: { id: string; accessToken: string }
  let extrano: { id: string; accessToken: string }
  let evento: string

  async function registrarYEntrar(
    email: string,
    fullName: string,
  ): Promise<{ id: string; accessToken: string }> {
    const registro = await request(url)
      .post('/auth/register')
      .send({ email, password: 'una-contraseña-larga', fullName })
      .expect(201)

    await prisma.user.update({
      where: { email },
      data: { emailVerifiedAt: new Date() },
    })

    const login = await request(url)
      .post('/auth/login')
      .send({ email, password: 'una-contraseña-larga' })
      .expect(200)

    return {
      id: (registro.body as { id: string }).id,
      accessToken: (login.body as { accessToken: string }).accessToken,
    }
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    ana = await registrarYEntrar('ana@test.com', 'Ana')
    luis = await registrarYEntrar('luis@test.com', 'Luis')
    pia = await registrarYEntrar('pia@test.com', 'Pia')
    dj = await registrarYEntrar('dj@test.com', 'DJ')
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')

    evento = await crearEventoPublicado(url, ana.accessToken, 'Boda de Ana')

    // Aún no hay flujo de aceptar invitación: las membresías se crean a mano.
    await prisma.eventMembership.create({
      data: { eventId: evento, userId: luis.id, role: 'COUPLE', status: 'ACTIVE' },
    })
    await prisma.eventMembership.create({
      data: { eventId: evento, userId: pia.id, role: 'PLANNER', status: 'ACTIVE' },
    })

    const categoria = await categoriaId(prisma, 'music-entertainment')
    const perfil = await prisma.vendorProfile.create({
      data: { userId: dj.id, businessName: 'DJ Max', categoryId: categoria, status: 'PUBLISHED' },
    })
    await prisma.eventVendor.create({
      data: {
        eventId: evento,
        vendorProfileId: perfil.id,
        categoryId: categoria,
        status: 'BOOKED',
      },
    })
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('la creadora lista gastos, ve el resumen y crea/edita/borra', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    await request(url).get(`/events/${evento}/expenses`).set(auth).expect(200)
    await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(200)
    const creado = await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'Flores', category: 'Flowers', amount: '100', payeeName: 'Floristería' })
      .expect(201)
    const id = (creado.body as { id: string }).id
    await request(url)
      .patch(`/events/${evento}/expenses/${id}`)
      .set(auth)
      .send({ status: 'PAID' })
      .expect(200)
    await request(url).delete(`/events/${evento}/expenses/${id}`).set(auth).expect(204)
  })

  async function crearGastoDeAna(): Promise<string> {
    const creado = await request(url)
      .post(`/events/${evento}/expenses`)
      .set({ Authorization: `Bearer ${ana.accessToken}` })
      .send({ concept: 'Ajeno', category: 'Flowers', amount: '10', payeeName: 'Proveedor' })
      .expect(201)
    return (creado.body as { id: string }).id
  }

  it.each([
    ['COUPLE no creador', () => luis],
    ['PLANNER', () => pia],
    ['proveedor contratado', () => dj],
  ])('%s recibe 403 en lectura y escritura de gastos', async (_quien, usuario) => {
    const gasto = await crearGastoDeAna()
    const auth = { Authorization: `Bearer ${usuario().accessToken}` }
    await request(url).get(`/events/${evento}/expenses`).set(auth).expect(403)
    await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(403)
    await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'X', category: 'Y', amount: '1', payeeName: 'Z' })
      .expect(403)
    await request(url)
      .patch(`/events/${evento}/expenses/${gasto}`)
      .set(auth)
      .send({ status: 'PAID' })
      .expect(403)
    await request(url).delete(`/events/${evento}/expenses/${gasto}`).set(auth).expect(403)

    // Nada de lo anterior tocó los datos: el gasto sigue ahí, pendiente, y el POST no creó otro.
    const lista = await request(url)
      .get(`/events/${evento}/expenses`)
      .set({ Authorization: `Bearer ${ana.accessToken}` })
      .expect(200)
    const items = (lista.body as { items: { id: string; concept: string; status: string }[] }).items
    expect(items.find((g) => g.id === gasto)?.status).toBe('PENDING')
    expect(items.filter((g) => g.concept === 'X')).toHaveLength(0)
  })

  it('un usuario sin acceso al evento recibe 404 en las cinco rutas de gastos', async () => {
    const gasto = await crearGastoDeAna()
    const auth = { Authorization: `Bearer ${extrano.accessToken}` }
    await request(url).get(`/events/${evento}/expenses`).set(auth).expect(404)
    await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(404)
    await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'X', category: 'Y', amount: '1', payeeName: 'Z' })
      .expect(404)
    await request(url)
      .patch(`/events/${evento}/expenses/${gasto}`)
      .set(auth)
      .send({ status: 'PAID' })
      .expect(404)
    await request(url).delete(`/events/${evento}/expenses/${gasto}`).set(auth).expect(404)
  })
})
