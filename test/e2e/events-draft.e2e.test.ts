import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { categoriaId } from '../support/categorias'
import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { crearEventoPublicado } from '../support/eventos'

/**
 * e2e del ciclo de vida del borrador: crear con solo el nombre, completar por
 * PATCH, publicar (y fallar al publicar si falta algo), y la visibilidad de
 * un DRAFT frente a un VENDOR.
 */
describe('Borrador de evento e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let extrano: { id: string; accessToken: string }
  let fotografo: { id: string; accessToken: string }

  async function registrarYEntrar(
    email: string,
    fullName: string,
  ): Promise<{ id: string; accessToken: string }> {
    const registro = await request(url)
      .post('/auth/register')
      .send({ email, password: 'una-contraseña-larga', fullName })
      .expect(201)

    // El login exige el email verificado (Tarea 2): este test no ejercita ese
    // flujo, así que se marca directo en base de datos en vez de pasar por el
    // correo y el token de verificación.
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
    fotografo = await registrarYEntrar('foto@test.com', 'Fotógrafo')
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('crea un borrador solo con nombre', async () => {
    const res = await request(url)
      .post('/events')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Boda borrador' })
      .expect(201)
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      weddingDate: null,
      currency: 'USD',
      totalBudget: null,
      venue: null,
      completitud: { general: 'parcial', venue: 'vacio', schedule: 'vacio', budget: 'vacio' },
    })
  })

  it('PATCH parcial y publish con faltantes → 422 con details', async () => {
    const creado = await request(url)
      .post('/events')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Boda' })
      .expect(201)
    const id = (creado.body as { id: string }).id

    await request(url)
      .patch(`/events/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ totalBudget: '2500.5' })
      .expect(200)
      .expect((r) => expect((r.body as { totalBudget: string }).totalBudget).toBe('2500.50'))

    const fallo = await request(url)
      .post(`/events/${id}/publish`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(422)
    expect(fallo.body).toMatchObject({
      code: 'EVENT_INCOMPLETE',
      details: { faltantes: ['weddingDate', 'venue'] },
    })
  })

  it('un ACTIVE se edita entero, moneda incluida, pero no se puede vaciar el venue', async () => {
    const id = await crearEventoPublicado(url, ana.accessToken, 'Boda publicada')

    await request(url)
      .patch(`/events/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Renombrada', currency: 'EUR', weddingDate: '2027-07-01' })
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({ name: 'Renombrada', currency: 'EUR', status: 'ACTIVE' }),
      )

    const fallo = await request(url)
      .patch(`/events/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ venue: null })
      .expect(422)
    expect(fallo.body).toMatchObject({ details: { faltantes: ['venue'] } })
  })

  it.each([[{ totalBudget: '1,500' }], [{ totalBudget: 1e21 }], [{}], [{ status: 'ACTIVE' }]])(
    'PATCH con %o → 400',
    async (cuerpo) => {
      const id = await crearEventoPublicado(url, ana.accessToken, 'Boda 400')
      await request(url)
        .patch(`/events/${id}`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send(cuerpo)
        .expect(400)
    },
  )

  it('un extraño recibe 404 en PATCH y publish', async () => {
    const id = await crearEventoPublicado(url, ana.accessToken, 'Boda ajena')
    await request(url)
      .patch(`/events/${id}`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .send({ name: 'X' })
      .expect(404)
    await request(url)
      .post(`/events/${id}/publish`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)
  })

  it('un vendor BOOKED no ve el borrador; sí lo ve cuando se publica', async () => {
    const creado = await request(url)
      .post('/events')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({
        name: 'Boda con fotógrafo',
        weddingDate: '2027-06-12',
        totalBudget: 1,
        venue: { address: 'Calle 1', lat: 1, lng: 1 },
      })
      .expect(201)
    const id = (creado.body as { id: string }).id
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
        eventId: id,
        vendorProfileId: perfil.id,
        categoryId: await categoriaId(prisma, 'photography'),
        status: 'BOOKED',
      },
    })

    await request(url)
      .get(`/events/${id}`)
      .set('Authorization', `Bearer ${fotografo.accessToken}`)
      .expect(404)
    const lista = await request(url)
      .get('/events')
      .set('Authorization', `Bearer ${fotografo.accessToken}`)
      .expect(200)
    expect((lista.body as Array<{ id: string }>).map((e) => e.id)).not.toContain(id)

    await request(url)
      .post(`/events/${id}/publish`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)
    await request(url)
      .get(`/events/${id}`)
      .set('Authorization', `Bearer ${fotografo.accessToken}`)
      .expect(200)
  })
})
