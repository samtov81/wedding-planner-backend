import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { crearEventoPublicado } from '../support/eventos'

/**
 * Mismo arranque que `event-vendors.e2e.test.ts`: prueba contra el servidor
 * real, no una llamada directa a los casos de uso, porque lo que se quiere
 * comprobar es que `@RequireEventAccess` y `EventAccessGuard` están
 * realmente enganchados en estas rutas.
 */
describe('Cronograma del evento e2e', () => {
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

  it('CRUD del cronograma con estado', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    const creado = await request(url)
      .post(`/events/${evento}/schedule`)
      .set(auth)
      .send({
        title: 'Inicio de la fiesta',
        startsAt: '2027-06-12T22:00:00-05:00',
        location: { name: 'Salón', address: 'Cra 7 #1', lat: 4.6, lng: -74.07 },
      })
      .expect(201)
    const id = (creado.body as { id: string }).id
    expect(creado.body).toMatchObject({ status: 'PENDING', startsAt: '2027-06-13T03:00:00.000Z' })

    await request(url)
      .patch(`/events/${evento}/schedule/${id}`)
      .set(auth)
      .send({ status: 'DONE' })
      .expect(200)
    await request(url)
      .patch(`/events/${evento}/schedule/${id}`)
      .set(auth)
      .send({ endsAt: '2027-06-12T20:00:00-05:00' })
      .expect(422)

    const lista = await request(url).get(`/events/${evento}/schedule`).set(auth).expect(200)
    expect(lista.body).toHaveLength(1)

    await request(url).delete(`/events/${evento}/schedule/${id}`).set(auth).expect(204)
    await request(url).delete(`/events/${evento}/schedule/${id}`).set(auth).expect(404)
  })

  it('POST con fin antes de inicio → 400; id no UUID → 404; extraño → 404', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    await request(url)
      .post(`/events/${evento}/schedule`)
      .set(auth)
      .send({ title: 'X', startsAt: '2027-06-12T22:00:00Z', endsAt: '2027-06-12T21:00:00Z' })
      .expect(400)
    await request(url)
      .patch(`/events/${evento}/schedule/no-uuid`)
      .set(auth)
      .send({ title: 'X' })
      .expect(404)
    await request(url)
      .get(`/events/${evento}/schedule`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)
  })
})
