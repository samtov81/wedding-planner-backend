import type { Server } from 'node:http'

import type { INestApplication } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { TokenService } from '@/modules/auth/application/token.service'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { categoriaId } from '../support/categorias'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { limpiarContadoresDeRitmo } from '../support/throttler'

interface CuerpoMias {
  items: Array<{
    id: string
    type: string
    readAt: string | null
    createdAt: string
    event: { id: string; name: string }
  }>
  nextCursor: string | null
  unreadCount: number
}

describe('GET /me/notifications y POST /me/notifications/read-all e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let cerrar: () => Promise<void>
  let server: Server
  let app: INestApplication
  let prisma: PrismaClient
  let tokenPareja: string
  let tokenPlanner: string
  let parejaId: string
  let plannerId: string
  let eventoA: string
  let eventoB: string
  let membresiaPlannerA: string

  const MINUTO = 60_000
  const BASE = Date.now() - 60 * MINUTO

  async function sembrar(
    userId: string,
    eventId: string,
    minuto: number,
    leida = false,
  ): Promise<void> {
    await prisma.notification.create({
      data: {
        eventId,
        userId,
        type: 'guest.rsvp.updated',
        payload: { minuto },
        readAt: leida ? new Date(BASE) : null,
        createdAt: new Date(BASE + minuto * MINUTO),
      },
    })
  }

  const como = (token: string) => ({ Authorization: `Bearer ${token}` })

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    const arrancada = await arrancarAppDeTest()
    cerrar = arrancada.cerrar
    app = arrancada.app
    server = arrancada.app.getHttpServer()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    const pareja = await prisma.user.create({
      data: { email: 'pareja@test.com', passwordHash: 'x', fullName: 'Pareja' },
    })
    const planner = await prisma.user.create({
      data: { email: 'planner@test.com', passwordHash: 'x', fullName: 'Planner' },
    })
    parejaId = pareja.id
    plannerId = planner.id
    const tokens = arrancada.app.get(TokenService)
    tokenPareja = tokens.firmarAccess({ id: pareja.id, systemRole: pareja.systemRole })
    tokenPlanner = tokens.firmarAccess({ id: planner.id, systemRole: planner.systemRole })

    const weddingDate = new Date(Date.now() + 180 * 86_400_000)
    const a = await prisma.event.create({
      data: { name: 'Boda de Ana', weddingDate, ownerId: pareja.id },
    })
    const b = await prisma.event.create({
      data: { name: 'Aniversario', weddingDate, ownerId: pareja.id },
    })
    eventoA = a.id
    eventoB = b.id
    await prisma.eventMembership.createMany({
      data: [
        { eventId: eventoA, userId: pareja.id, role: 'COUPLE' },
        { eventId: eventoB, userId: pareja.id, role: 'COUPLE' },
      ],
    })
    const mp = await prisma.eventMembership.create({
      data: { eventId: eventoA, userId: planner.id, role: 'PLANNER' },
    })
    membresiaPlannerA = mp.id
    await prisma.eventMembership.create({
      data: { eventId: eventoB, userId: planner.id, role: 'PLANNER' },
    })
  }, 240_000)

  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
    await prisma.notification.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  })

  it('sin token responde 401', async () => {
    await request(server).get('/me/notifications').expect(401)
    await request(server).post('/me/notifications/read-all').expect(401)
  })

  it('lista las de todos mis eventos con su nombre, más recientes primero', async () => {
    await sembrar(parejaId, eventoA, 1)
    await sembrar(parejaId, eventoB, 2)
    await sembrar(parejaId, eventoA, 3, true)
    await sembrar(plannerId, eventoA, 4)

    const r = await request(server).get('/me/notifications').set(como(tokenPareja)).expect(200)
    const cuerpo = r.body as CuerpoMias

    expect(cuerpo.items.map((n) => n.event.name)).toEqual([
      'Boda de Ana',
      'Aniversario',
      'Boda de Ana',
    ])
    expect(cuerpo.items[1]?.event.id).toBe(eventoB)
    expect(cuerpo.items[0]?.readAt).not.toBeNull()
    expect(cuerpo.nextCursor).toBeNull()
    expect(cuerpo.unreadCount).toBe(2)
  })

  it('tras revocarme de un evento no veo ni cuento sus notificaciones', async () => {
    await sembrar(plannerId, eventoA, 1)
    await sembrar(plannerId, eventoB, 2)

    const antes = await request(server).get('/me/notifications').set(como(tokenPlanner)).expect(200)
    expect((antes.body as CuerpoMias).unreadCount).toBe(2)

    await request(server)
      .delete(`/events/${eventoA}/members/${membresiaPlannerA}`)
      .set(como(tokenPareja))
      .expect(204)

    const despues = await request(server)
      .get('/me/notifications')
      .set(como(tokenPlanner))
      .expect(200)
    const cuerpo = despues.body as CuerpoMias
    expect(cuerpo.items.map((n) => n.event.name)).toEqual(['Aniversario'])
    expect(cuerpo.unreadCount).toBe(1)
  })

  it('read-all responde 204, deja unreadCount en 0 y repetirlo también es 204', async () => {
    await sembrar(parejaId, eventoA, 1)
    await sembrar(parejaId, eventoB, 2)

    await request(server).post('/me/notifications/read-all').set(como(tokenPareja)).expect(204)
    await request(server).post('/me/notifications/read-all').set(como(tokenPareja)).expect(204)

    const r = await request(server).get('/me/notifications').set(como(tokenPareja)).expect(200)
    expect((r.body as CuerpoMias).unreadCount).toBe(0)
  })

  describe('proveedor contratado', () => {
    /**
     * Siembra el escenario explícito: un evento (publicado o en borrador), un
     * proveedor BOOKED en él y su aviso `event.vendor.booked`.
     */
    async function sembrarProveedor(
      email: string,
      status: 'ACTIVE' | 'DRAFT',
    ): Promise<{ tokenProv: string; eventId: string; contratacionId: string }> {
      const prov = await prisma.user.create({
        data: { email, passwordHash: 'x', fullName: 'Prov' },
      })
      const categoria = await categoriaId(prisma)
      const perfil = await prisma.vendorProfile.create({
        data: { userId: prov.id, businessName: `Negocio ${email}`, categoryId: categoria },
      })
      const evento = await prisma.event.create({
        data: {
          name: status === 'ACTIVE' ? 'Boda publicada' : 'Boda en borrador',
          weddingDate: new Date(Date.now() + 180 * 86_400_000),
          ownerId: parejaId,
          status,
        },
      })
      const contratacion = await prisma.eventVendor.create({
        data: {
          eventId: evento.id,
          vendorProfileId: perfil.id,
          categoryId: categoria,
          status: 'BOOKED',
        },
      })
      await prisma.notification.create({
        data: {
          eventId: evento.id,
          userId: prov.id,
          type: 'event.vendor.booked',
          payload: { eventVendorId: contratacion.id },
        },
      })
      const tokenProv = app
        .get(TokenService)
        .firmarAccess({ id: prov.id, systemRole: prov.systemRole })
      return { tokenProv, eventId: evento.id, contratacionId: contratacion.id }
    }

    it('un proveedor contratado ve su aviso con el nombre del evento y lo marca leído (204)', async () => {
      const { tokenProv, eventId } = await sembrarProveedor('prov@test.com', 'ACTIVE')

      const r = await request(server).get('/me/notifications').set(como(tokenProv)).expect(200)
      const cuerpo = r.body as CuerpoMias
      expect(cuerpo.items).toHaveLength(1)
      expect(cuerpo.items[0]).toMatchObject({
        type: 'event.vendor.booked',
        event: { id: eventId, name: 'Boda publicada' },
        readAt: null,
      })
      expect(cuerpo.unreadCount).toBe(1)

      await request(server)
        .post(`/events/${eventId}/notifications/${cuerpo.items[0]?.id ?? ''}/read`)
        .set(como(tokenProv))
        .expect(204)

      const despues = await request(server)
        .get('/me/notifications')
        .set(como(tokenProv))
        .expect(200)
      expect((despues.body as CuerpoMias).unreadCount).toBe(0)
      expect((despues.body as CuerpoMias).items[0]?.readAt).not.toBeNull()
    })

    it('un proveedor contratado en un evento sin publicar no ve el aviso hasta que se publica', async () => {
      const { tokenProv, eventId } = await sembrarProveedor('prov3@test.com', 'DRAFT')

      const antes = await request(server).get('/me/notifications').set(como(tokenProv)).expect(200)
      expect((antes.body as CuerpoMias).items).toEqual([])
      expect((antes.body as CuerpoMias).unreadCount).toBe(0)

      await prisma.event.update({ where: { id: eventId }, data: { status: 'ACTIVE' } })

      const despues = await request(server)
        .get('/me/notifications')
        .set(como(tokenProv))
        .expect(200)
      expect((despues.body as CuerpoMias).items).toHaveLength(1)
      expect((despues.body as CuerpoMias).unreadCount).toBe(1)
    })

    it('al cancelar su contratación el aviso desaparece del listado y del contador', async () => {
      const { tokenProv, contratacionId } = await sembrarProveedor('prov2@test.com', 'ACTIVE')
      await prisma.eventVendor.update({
        where: { id: contratacionId },
        data: { status: 'CANCELLED' },
      })

      const r = await request(server).get('/me/notifications').set(como(tokenProv)).expect(200)
      expect((r.body as CuerpoMias).items).toEqual([])
      expect((r.body as CuerpoMias).unreadCount).toBe(0)
    })
  })

  it('limit=101 es 400', async () => {
    await request(server).get('/me/notifications?limit=101').set(como(tokenPareja)).expect(400)
  })

  it('un cursor ilegible es 400', async () => {
    await request(server).get('/me/notifications?cursor=basura').set(como(tokenPareja)).expect(400)
  })
})
