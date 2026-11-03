import type { Server } from 'node:http'

import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { TokenService } from '@/modules/auth/application/token.service'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { categoriaId } from '../support/categorias'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { limpiarContadoresDeRitmo } from '../support/throttler'

/**
 * Humo de las rutas de contacto desde la ficha (Tarea 4): una ruta de cada
 * clase y el límite por usuario contra el Redis real. La matriz completa es la
 * Tarea 5.
 */
describe('contacto desde la ficha e2e (humo)', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let cerrar: () => Promise<void>
  let server: Server
  let prisma: PrismaClient
  let fichaId: string
  let tok: { pareja: string; prov: string }

  const como = (token: string) => ({ Authorization: `Bearer ${token}` })

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    const arrancada = await arrancarAppDeTest()
    cerrar = arrancada.cerrar
    server = arrancada.app.getHttpServer()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const tokens = arrancada.app.get(TokenService)
    const crear = async (nombre: string) => {
      const u = await prisma.user.create({
        data: { email: `${nombre}@contacto.test`, passwordHash: 'x', fullName: nombre },
      })
      return { id: u.id, token: tokens.firmarAccess({ id: u.id, systemRole: u.systemRole }) }
    }
    const pareja = await crear('pareja')
    const prov = await crear('prov')
    tok = { pareja: pareja.token, prov: prov.token }
    const perfil = await prisma.vendorProfile.create({
      data: {
        userId: prov.id,
        businessName: 'Foto',
        categoryId: await categoriaId(prisma, 'photography'),
        status: 'PUBLISHED',
      },
    })
    fichaId = perfil.id
  }, 240_000)

  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
    await prisma.message.deleteMany()
    await prisma.conversation.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  })

  it('pedir, aceptar y leer el historial con la forma de la 1:1', async () => {
    await request(server).get(`/vendors/${fichaId}/contact`).expect(401)
    const estado = await request(server)
      .get(`/vendors/${fichaId}/contact`)
      .set(como(tok.pareja))
      .expect(200)
    expect(estado.body).toMatchObject({ conversationId: null, retryAt: null })

    const pedido = await request(server)
      .post(`/vendors/${fichaId}/contact`)
      .set(como(tok.pareja))
      .send({ body: 'Hola, ¿tenéis fecha?' })
      .expect(201)
    const conv = pedido.body as { conversation: { id: string; kind: string; status: string } }
    expect(conv.conversation).toMatchObject({ kind: 'PROFILE', status: 'PENDING' })

    const bandeja = await request(server)
      .get('/me/profile-conversations')
      .set(como(tok.prov))
      .expect(200)
    expect(bandeja.body).toMatchObject({ requestsPending: 1 })

    await request(server)
      .post(`/conversations/${conv.conversation.id}/accept`)
      .set(como(tok.prov))
      .expect(200)
    const pagina = await request(server)
      .get(`/conversations/${conv.conversation.id}/messages`)
      .set(como(tok.pareja))
      .expect(200)
    expect(pagina.body).toHaveProperty('otherMarks')
  })

  it('un id que no es UUID responde 404, no 500', async () => {
    await request(server).get('/vendors/no-uuid/contact').set(como(tok.pareja)).expect(404)
    await request(server).post('/conversations/no-uuid/accept').set(como(tok.prov)).expect(404)
  })

  it('la petición 11.ª de la hora responde 429 aunque las anteriores fallaran', async () => {
    const inexistente = '00000000-0000-4000-8000-000000000000'
    for (let i = 0; i < 10; i++) {
      await request(server)
        .post(`/vendors/${inexistente}/contact`)
        .set(como(tok.pareja))
        .send({ body: 'hola' })
        .expect(404)
    }
    await request(server)
      .post(`/vendors/${inexistente}/contact`)
      .set(como(tok.pareja))
      .send({ body: 'hola' })
      .expect(429)
    // Otro usuario no comparte cupo.
    await request(server)
      .post(`/vendors/${inexistente}/contact`)
      .set(como(tok.prov))
      .send({ body: 'hola' })
      .expect(404)
  })
})
