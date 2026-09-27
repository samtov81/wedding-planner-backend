import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { categoriaId } from '../support/categorias'
import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { crearEventoPublicado } from '../support/eventos'

/**
 * e2e de `ExpensesController`: comprueba que `EventAccessGuard` +
 * `RequireEventAccess` están de verdad enganchados en las cinco rutas y que
 * el flujo completo (gasto de vendor, externo, pagar, filtrar y resumen)
 * cuadra con `calcularResumen` contra un servidor real, no un fake.
 */
describe('Gastos e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
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
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')

    evento = await crearEventoPublicado(url, ana.accessToken, 'Boda de Ana')
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('flujo completo: gasto de vendor, externo, pagar, filtrar, resumen y 409 al borrar vendor', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    const vendor = await request(url)
      .post(`/events/${evento}/vendors`)
      .set(auth)
      .send({ externalName: 'DJ Max', category: 'music-entertainment', assignedBudget: 500 })
      .expect(201)
    const vendorId = (vendor.body as { id: string }).id

    const deVendor = await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({
        concept: 'Anticipo DJ',
        category: 'Music',
        amount: '200',
        eventVendorId: vendorId,
        dueDate: '2027-05-01',
      })
      .expect(201)
    expect(deVendor.body).toMatchObject({
      origin: { kind: 'vendor', eventVendorId: vendorId, vendorName: 'DJ Max' },
      amount: '200.00',
      status: 'PENDING',
      dueDate: '2027-05-01',
      paidAt: null,
    })

    await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({
        concept: 'Invitaciones',
        category: 'Stationery',
        amount: 80.5,
        payeeName: 'Imprenta',
        status: 'PAID',
      })
      .expect(201)

    const pagado = await request(url)
      .patch(`/events/${evento}/expenses/${(deVendor.body as { id: string }).id}`)
      .set(auth)
      .send({ status: 'PAID' })
      .expect(200)
    expect((pagado.body as { paidAt: string | null }).paidAt).not.toBeNull()

    const externos = await request(url)
      .get(`/events/${evento}/expenses?origin=external`)
      .set(auth)
      .expect(200)
    expect((externos.body as { items: unknown[] }).items).toHaveLength(1)

    const resumen = await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(200)
    expect(resumen.body).toEqual({
      currency: 'USD',
      totalBudget: '10000.00',
      assigned: '500.00',
      unassigned: '9500.00',
      paid: '280.50',
      pending: '0.00',
      remaining: '9719.50',
    })

    await request(url).delete(`/events/${evento}/vendors/${vendorId}`).set(auth).expect(409)
  })

  it('eventVendorId de otro evento → 404; no-uuid → 400; extraño → 404', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    const otroEvento = await crearEventoPublicado(url, ana.accessToken, 'Otra boda')
    const ajeno = await request(url)
      .post(`/events/${otroEvento}/vendors`)
      .set(auth)
      .send({ externalName: 'Ajeno', category: 'media' })
      .expect(201)

    await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({
        concept: 'X',
        category: 'X',
        amount: 1,
        eventVendorId: (ajeno.body as { id: string }).id,
      })
      .expect(404)
    await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'X', category: 'X', amount: 1, eventVendorId: 'no-uuid' })
      .expect(400)
    await request(url)
      .get(`/events/${evento}/expenses`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)
  })

  it('un vendor BOOKED sobre un DRAFT recibe 404, no 403, en gastos y en el resumen', async () => {
    // Mismo motivo que `events-draft.e2e`: un 403 en vez de 404 delataría que
    // el borrador existe. `buscarContratacionReservada` sólo mira eventos
    // ACTIVE, así que un DRAFT tiene que dar 404 también en estas rutas.
    const fotografo = await registrarYEntrar('foto-expenses@test.com', 'Fotógrafo')
    const creado = await request(url)
      .post('/events')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Boda con fotógrafo (expenses)' })
      .expect(201)
    const draft = (creado.body as { id: string }).id
    const perfil = await prisma.vendorProfile.create({
      data: {
        userId: fotografo.id,
        businessName: 'Luz',
        categoryId: await categoriaId(prisma, 'photography'),
        status: 'PUBLISHED',
      },
    })
    await prisma.eventVendor.create({
      data: {
        eventId: draft,
        vendorProfileId: perfil.id,
        categoryId: await categoriaId(prisma, 'photography'),
        status: 'BOOKED',
      },
    })

    const auth = { Authorization: `Bearer ${fotografo.accessToken}` }
    await request(url).get(`/events/${draft}/expenses`).set(auth).expect(404)
    await request(url).get(`/events/${draft}/budget-summary`).set(auth).expect(404)
  })
})
