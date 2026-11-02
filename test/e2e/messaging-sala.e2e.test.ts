import type { Server } from 'node:http'

import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { io, type Socket as SocketCliente } from 'socket.io-client'
import request from 'supertest'

import { TokenService } from '@/modules/auth/application/token.service'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { categoriaId } from '../support/categorias'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { limpiarContadoresDeRitmo } from '../support/throttler'

interface SalaCuerpo {
  id: string
  kind: 'EVENT_ROOM'
  event: { id: string; name: string }
  memberCount: number
  lastMessage: { id: string; body: string } | null
  unreadCount: number
  readOnly: boolean
}

interface MensajeCuerpo {
  id: string
  conversationId: string
  senderId: string
  body: string
  createdAt: string
  recipientIds?: string[]
  receipts?: { total: number; delivered: number; read: number }
}

interface PaginaSalaCuerpo {
  items: MensajeCuerpo[]
  nextCursor: string | null
  marks: Array<{ userId: string; displayName: string; role: string }>
}

type Quien = 'pareja' | 'planner' | 'tarde' | 'prov' | 'admin'

describe('sala del evento e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let cerrar: () => Promise<void>
  let server: Server
  let url: string
  const abiertos: SocketCliente[] = []
  let prisma: PrismaClient
  let eventoId: string
  let t: Record<Quien, string>
  let id: Record<Quien, string>

  const como = (token: string) => ({ Authorization: `Bearer ${token}` })

  async function sala(token: string): Promise<SalaCuerpo> {
    const r = await request(server).get(`/events/${eventoId}/room`).set(como(token)).expect(200)
    return r.body as SalaCuerpo
  }

  async function enviar(token: string, salaId: string, body: string): Promise<MensajeCuerpo> {
    const r = await request(server)
      .post(`/conversations/${salaId}/messages`)
      .set(como(token))
      .send({ body })
      .expect(201)
    return r.body as MensajeCuerpo
  }

  async function pagina(token: string, salaId: string): Promise<PaginaSalaCuerpo> {
    const r = await request(server)
      .get(`/conversations/${salaId}/messages`)
      .set(como(token))
      .expect(200)
    return r.body as PaginaSalaCuerpo
  }

  function leer(token: string, salaId: string, upTo: string): request.Test {
    return request(server).post(`/conversations/${salaId}/read`).set(como(token)).send({ upTo })
  }

  async function membresia(userId: string, status: 'ACTIVE' | 'REVOKED'): Promise<void> {
    await prisma.eventMembership.upsert({
      where: { eventId_userId: { eventId: eventoId, userId } },
      create: { eventId: eventoId, userId, role: 'PLANNER', status },
      update: { status },
    })
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    const arrancada = await arrancarAppDeTest()
    cerrar = arrancada.cerrar
    server = arrancada.app.getHttpServer()
    url = arrancada.url
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const tokens = arrancada.app.get(TokenService)

    const crear = async (nombre: Quien) => {
      const u = await prisma.user.create({
        data: {
          email: `${nombre}@sala.test`,
          passwordHash: 'x',
          fullName: nombre,
          ...(nombre === 'admin' ? { systemRole: 'ADMIN' as const } : {}),
        },
      })
      return { id: u.id, token: tokens.firmarAccess({ id: u.id, systemRole: u.systemRole }) }
    }
    const [pareja, planner, tarde, prov, admin] = await Promise.all([
      crear('pareja'),
      crear('planner'),
      crear('tarde'),
      crear('prov'),
      crear('admin'),
    ])
    id = {
      pareja: pareja.id,
      planner: planner.id,
      tarde: tarde.id,
      prov: prov.id,
      admin: admin.id,
    }
    t = {
      pareja: pareja.token,
      planner: planner.token,
      tarde: tarde.token,
      prov: prov.token,
      admin: admin.token,
    }

    const evento = await prisma.event.create({
      data: {
        name: 'Boda de Ana',
        weddingDate: new Date(Date.now() + 180 * 86_400_000),
        ownerId: id.pareja,
        status: 'ACTIVE',
      },
    })
    eventoId = evento.id
    await prisma.eventMembership.create({
      data: { eventId: eventoId, userId: id.pareja, role: 'COUPLE' },
    })
    const categoryId = await categoriaId(prisma, 'photography')
    const perfil = await prisma.vendorProfile.create({
      data: { userId: id.prov, businessName: 'Foto', categoryId, status: 'PUBLISHED' },
    })
    await prisma.eventVendor.create({
      data: { eventId: eventoId, vendorProfileId: perfil.id, categoryId, status: 'BOOKED' },
    })
  }, 240_000)

  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
    await prisma.message.deleteMany()
    await prisma.conversation.deleteMany()
    await prisma.eventMembership.deleteMany({
      where: { eventId: eventoId, userId: { in: [id.planner, id.tarde] } },
    })
    await membresia(id.planner, 'ACTIVE')
  })

  afterEach(() => {
    for (const socket of abiertos.splice(0)) socket.disconnect()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  })

  it('sin token las rutas de sala responden 401', async () => {
    await request(server).get('/me/rooms').expect(401)
    await request(server).get(`/events/${eventoId}/room`).expect(401)
    await request(server)
      .get(`/conversations/${id.pareja}/messages/${id.pareja}/readers`)
      .expect(401)
  })

  it('el creador ve la sala vacía, una sola aunque la abra dos veces', async () => {
    const una = await sala(t.pareja)
    const otra = await sala(t.pareja)
    expect(otra.id).toBe(una.id)
    expect(una).toEqual({
      id: una.id,
      kind: 'EVENT_ROOM',
      event: { id: eventoId, name: 'Boda de Ana' },
      memberCount: 2,
      lastMessage: null,
      unreadCount: 0,
      readOnly: false,
    })
  })

  it('un proveedor y un admin no miembro reciben 403 y el proveedor nunca es destinatario', async () => {
    const { id: salaId } = await sala(t.pareja)
    for (const token of [t.prov, t.admin]) {
      const r = await request(server).get(`/events/${eventoId}/room`).set(como(token)).expect(403)
      expect((r.body as { code: string }).code).toBe('ROOM_ACCESS_DENIED')
      await request(server).get(`/conversations/${salaId}/messages`).set(como(token)).expect(404)
    }
    const m = await enviar(t.pareja, salaId, 'hola')
    expect(m.recipientIds).toBeUndefined()
    const mia = (await pagina(t.pareja, salaId)).items[0]
    expect(mia?.recipientIds).toEqual([id.planner])
    expect((await request(server).get('/me/rooms').set(como(t.prov)).expect(200)).body).toEqual({
      items: [],
      unreadTotal: 0,
    })
  })

  it('quien entra tarde ve el historial con 0 no leídos', async () => {
    const { id: salaId } = await sala(t.pareja)
    await enviar(t.pareja, salaId, 'antes de que llegues')
    await membresia(id.tarde, 'ACTIVE')

    const r = await request(server).get('/me/rooms').set(como(t.tarde)).expect(200)
    expect(r.body).toMatchObject({
      items: [{ id: salaId, unreadCount: 0, readOnly: false, memberCount: 3 }],
      unreadTotal: 0,
    })
    expect((await pagina(t.tarde, salaId)).items.map((m) => m.body)).toEqual([
      'antes de que llegues',
    ])
    await enviar(t.pareja, salaId, 'ya estás')
    expect((await sala(t.tarde)).unreadCount).toBe(1)
  })

  it('"leído por N de M" sube al leer y readers sólo lo ve el remitente', async () => {
    await membresia(id.tarde, 'ACTIVE')
    const { id: salaId } = await sala(t.pareja)
    const m = await enviar(t.pareja, salaId, 'reunión el lunes')

    const antes = (await pagina(t.pareja, salaId)).items[0]
    expect(antes?.receipts).toEqual({ total: 2, delivered: 0, read: 0 })

    await leer(t.planner, salaId, m.id).expect(204)
    const despues = (await pagina(t.pareja, salaId)).items[0]
    expect(despues?.receipts).toEqual({ total: 2, delivered: 1, read: 1 })

    const r = await request(server)
      .get(`/conversations/${salaId}/messages/${m.id}/readers`)
      .set(como(t.pareja))
      .expect(200)
    expect(r.body).toEqual({
      read: [{ userId: id.planner, displayName: 'planner', role: 'PLANNER' }],
      unread: [{ userId: id.tarde, displayName: 'tarde', role: 'PLANNER' }],
    })
    await request(server)
      .get(`/conversations/${salaId}/messages/${m.id}/readers`)
      .set(como(t.planner))
      .expect(404)
  })

  it('un revocado lee hasta su salida, no escribe y no marca lo posterior', async () => {
    const { id: salaId } = await sala(t.pareja)
    await enviar(t.pareja, salaId, 'antes')
    await membresia(id.planner, 'REVOKED')
    const despues = await enviar(t.pareja, salaId, 'después')

    expect(await sala(t.planner)).toMatchObject({
      readOnly: true,
      lastMessage: { body: 'antes' },
      memberCount: 1,
    })
    expect((await pagina(t.planner, salaId)).items.map((m) => m.body)).toEqual(['antes'])
    const r = await request(server)
      .post(`/conversations/${salaId}/messages`)
      .set(como(t.planner))
      .send({ body: 'hola' })
      .expect(403)
    expect((r.body as { code: string }).code).toBe('CONVERSATION_READ_ONLY')
    await leer(t.planner, salaId, despues.id).expect(404)

    // Readmitido: vuelve a escribir y lo ve todo.
    await membresia(id.planner, 'ACTIVE')
    expect((await pagina(t.planner, salaId)).items.map((m) => m.body)).toEqual(['después', 'antes'])
    await enviar(t.planner, salaId, 'he vuelto')
  })

  it('las salas no salen en la bandeja 1:1', async () => {
    const { id: salaId } = await sala(t.pareja)
    await enviar(t.pareja, salaId, 'hola')
    const r = await request(server).get('/me/conversations').set(como(t.planner)).expect(200)
    expect(r.body).toEqual({ items: [], unreadTotal: 0 })
  })

  describe('tiempo real', () => {
    async function conectarComo(token: string): Promise<SocketCliente> {
      const socket = io(`${url}/realtime`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      })
      abiertos.push(socket)
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('connect_error', reject)
      })
      return socket
    }

    function esperar(socket: SocketCliente, evento: string, ms = 10_000): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const reloj = setTimeout(() => reject(new Error(`no llegó ${evento} en ${ms} ms`)), ms)
        socket.once(evento, (datos: unknown) => {
          clearTimeout(reloj)
          resolve(datos)
        })
      })
    }

    it('message.created llega a la sala y message.receipt al remitente; el proveedor no recibe nada', async () => {
      const { id: salaId } = await sala(t.pareja)
      const socketPareja = await conectarComo(t.pareja)
      const socketPlanner = await conectarComo(t.planner)
      const socketProv = await conectarComo(t.prov)
      const recibidosProv: string[] = []
      socketProv.onAny((evento: string) => recibidosProv.push(evento))

      const llega = esperar(socketPlanner, 'message.created')
      const m = await enviar(t.pareja, salaId, 'hola a todos')
      expect(await llega).toEqual({
        conversationId: salaId,
        message: {
          id: m.id,
          conversationId: salaId,
          senderId: id.pareja,
          body: 'hola a todos',
          createdAt: m.createdAt,
        },
      })

      const recibo = esperar(socketPareja, 'message.receipt')
      await leer(t.planner, salaId, m.id).expect(204)
      expect(await recibo).toEqual({
        conversationId: salaId,
        userId: id.planner,
        deliveredUpTo: null,
        readUpTo: { at: m.createdAt, id: m.id },
      })
      expect(recibidosProv).toEqual([])
    })
  })

  it('el límite de ritmo de envío también vale en la sala: 429 al mensaje 31', async () => {
    const { id: salaId } = await sala(t.pareja)
    for (let i = 0; i < 30; i += 1) await enviar(t.pareja, salaId, `m${i}`)
    await request(server)
      .post(`/conversations/${salaId}/messages`)
      .set(como(t.pareja))
      .send({ body: 'uno más' })
      .expect(429)
  })
})
