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

interface ConversacionCuerpo {
  id: string
  event: { id: string; name: string }
  other: { userId: string; displayName: string; role: string }
  lastMessage: { id: string; body: string } | null
  unreadCount: number
  readOnly: boolean
  otherMarks: {
    deliveredUpTo: { at: string; id: string } | null
    readUpTo: { at: string; id: string } | null
  }
}

interface MensajeCuerpo {
  id: string
  conversationId: string
  senderId: string
  body: string
  createdAt: string
}

interface PaginaCuerpo {
  items: MensajeCuerpo[]
  nextCursor: string | null
  otherMarks: ConversacionCuerpo['otherMarks']
}

interface BandejaCuerpo {
  items: ConversacionCuerpo[]
  unreadTotal: number
}

describe('mensajería REST e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let cerrar: () => Promise<void>
  let server: Server
  let url: string
  const abiertos: SocketCliente[] = []
  let prisma: PrismaClient
  let eventoId: string
  let eventoAjenoId: string
  let t: Record<'pareja' | 'planner' | 'provA' | 'provB' | 'admin' | 'ajeno', string>
  let id: Record<'pareja' | 'planner' | 'provA' | 'provB' | 'admin' | 'ajeno', string>
  let contratacionA: string

  const como = (token: string) => ({ Authorization: `Bearer ${token}` })

  function abrir(token: string, eventId: string, userId: string): request.Test {
    return request(server)
      .post(`/events/${eventId}/conversations`)
      .set(como(token))
      .send({ userId })
  }

  async function conversacionEntre(
    token: string,
    userId: string,
    eventId = eventoId,
  ): Promise<string> {
    const r = await abrir(token, eventId, userId)
    return (r.body as ConversacionCuerpo).id
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

    const crear = async (nombre: string, admin = false) => {
      const u = await prisma.user.create({
        data: {
          email: `${nombre}@msg.test`,
          passwordHash: 'x',
          fullName: nombre,
          ...(admin ? { systemRole: 'ADMIN' as const } : {}),
        },
      })
      return { id: u.id, token: tokens.firmarAccess({ id: u.id, systemRole: u.systemRole }) }
    }
    const [pareja, planner, provA, provB, admin, ajeno] = await Promise.all([
      crear('pareja'),
      crear('planner'),
      crear('provA'),
      crear('provB'),
      crear('admin', true),
      crear('ajeno'),
    ])
    id = {
      pareja: pareja.id,
      planner: planner.id,
      provA: provA.id,
      provB: provB.id,
      admin: admin.id,
      ajeno: ajeno.id,
    }
    t = {
      pareja: pareja.token,
      planner: planner.token,
      provA: provA.token,
      provB: provB.token,
      admin: admin.token,
      ajeno: ajeno.token,
    }

    const weddingDate = new Date(Date.now() + 180 * 86_400_000)
    const evento = await prisma.event.create({
      data: { name: 'Boda de Ana', weddingDate, ownerId: pareja.id, status: 'ACTIVE' },
    })
    eventoId = evento.id
    const otro = await prisma.event.create({
      data: { name: 'Evento ajeno', weddingDate, ownerId: ajeno.id, status: 'ACTIVE' },
    })
    eventoAjenoId = otro.id
    await prisma.eventMembership.createMany({
      data: [
        { eventId: eventoId, userId: pareja.id, role: 'COUPLE' },
        { eventId: eventoId, userId: planner.id, role: 'PLANNER' },
        { eventId: eventoAjenoId, userId: ajeno.id, role: 'COUPLE' },
      ],
    })
    const categoryId = await categoriaId(prisma, 'photography')
    for (const [uid, nombre] of [
      [provA.id, 'Foto A'],
      [provB.id, 'Flores B'],
    ] as const) {
      const perfil = await prisma.vendorProfile.create({
        data: { userId: uid, businessName: nombre, categoryId, status: 'PUBLISHED' },
      })
      const c = await prisma.eventVendor.create({
        data: { eventId: eventoId, vendorProfileId: perfil.id, categoryId, status: 'BOOKED' },
      })
      if (uid === provA.id) contratacionA = c.id
    }
  }, 240_000)

  afterEach(() => {
    for (const socket of abiertos.splice(0)) socket.disconnect()
  })

  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
    await prisma.message.deleteMany()
    await prisma.conversation.deleteMany()
    await prisma.event.update({ where: { id: eventoId }, data: { status: 'ACTIVE' } })
    await prisma.eventVendor.update({ where: { id: contratacionA }, data: { status: 'BOOKED' } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  })

  it('sin token todas las rutas responden 401', async () => {
    await request(server).get('/me/conversations').expect(401)
    await request(server).get(`/events/${eventoId}/contacts`).expect(401)
    await request(server).post(`/events/${eventoId}/conversations`).expect(401)
    await request(server).get(`/conversations/${id.pareja}/messages`).expect(401)
    await request(server).post(`/conversations/${id.pareja}/messages`).expect(401)
    await request(server).post(`/conversations/${id.pareja}/read`).expect(401)
  })

  describe('contactos', () => {
    it('la pareja ve al planner y a los dos proveedores', async () => {
      const r = await request(server)
        .get(`/events/${eventoId}/contacts`)
        .set(como(t.pareja))
        .expect(200)
      const nombres = (r.body as { items: Array<{ displayName: string }> }).items
        .map((c) => c.displayName)
        .sort()
      expect(nombres).toEqual(['Flores B', 'Foto A', 'planner'])
    })

    it('un proveedor no ve a otros proveedores', async () => {
      const r = await request(server)
        .get(`/events/${eventoId}/contacts`)
        .set(como(t.provA))
        .expect(200)
      const items = (r.body as { items: Array<{ role: string }> }).items
      expect(items.map((c) => c.role).sort()).toEqual(['COUPLE', 'PLANNER'])
    })

    it('sin acceso al evento responde 403; un id mal formado, 404', async () => {
      await request(server).get(`/events/${eventoId}/contacts`).set(como(t.ajeno)).expect(403)
      await request(server).get(`/events/${eventoId}/contacts`).set(como(t.admin)).expect(403)
      await request(server).get('/events/no-es-uuid/contacts').set(como(t.pareja)).expect(404)
    })
  })

  describe('abrir', () => {
    it('abrir dos veces devuelve la misma (201 y luego 200)', async () => {
      const primera = await abrir(t.pareja, eventoId, id.provA)
      expect(primera.status).toBe(201)
      const cuerpo = primera.body as ConversacionCuerpo
      expect(cuerpo.other).toMatchObject({ userId: id.provA, displayName: 'Foto A' })
      expect(cuerpo.readOnly).toBe(false)

      const segunda = await abrir(t.provA, eventoId, id.pareja)
      expect(segunda.status).toBe(200)
      expect((segunda.body as ConversacionCuerpo).id).toBe(cuerpo.id)
    })

    it('un proveedor no puede abrir con otro proveedor (403)', async () => {
      await abrir(t.provA, eventoId, id.provB).then((r) => expect(r.status).toBe(403))
    })

    it('un admin no miembro no puede abrir (403)', async () => {
      await abrir(t.admin, eventoId, id.pareja).then((r) => expect(r.status).toBe(403))
    })

    it('con alguien sin acceso al evento responde 404', async () => {
      await abrir(t.pareja, eventoId, id.ajeno).then((r) => expect(r.status).toBe(404))
      await abrir(t.pareja, eventoId, id.admin).then((r) => expect(r.status).toBe(404))
    })

    it('un proveedor no accede si el evento no está publicado', async () => {
      await prisma.event.update({ where: { id: eventoId }, data: { status: 'DRAFT' } })
      await abrir(t.provA, eventoId, id.pareja).then((r) => expect(r.status).toBe(403))
      await abrir(t.pareja, eventoId, id.provA).then((r) => expect(r.status).toBe(404))
    })

    it('conmigo mismo es 403 y un userId mal formado es 400', async () => {
      await abrir(t.pareja, eventoId, id.pareja).then((r) => expect(r.status).toBe(403))
      await abrir(t.pareja, eventoId, 'x').then((r) => expect(r.status).toBe(400))
    })
  })

  describe('mensajes', () => {
    it('cuenta puntos de código: 2000 emoji se aceptan (201) y 2001 dan 400', async () => {
      const conv = await conversacionEntre(t.pareja, id.provA)
      await request(server)
        .post(`/conversations/${conv}/messages`)
        .set(como(t.pareja))
        .send({ body: '😀'.repeat(2000) })
        .expect(201)
      await request(server)
        .post(`/conversations/${conv}/messages`)
        .set(como(t.pareja))
        .send({ body: '😀'.repeat(2001) })
        .expect(400)
    })

    it('enviar y leer la bandeja del otro: unreadCount 1, luego read → 0', async () => {
      const conv = await conversacionEntre(t.pareja, id.provA)
      const enviado = await request(server)
        .post(`/conversations/${conv}/messages`)
        .set(como(t.pareja))
        .send({ body: '  Hola  ' })
        .expect(201)
      const mensaje = enviado.body as MensajeCuerpo
      expect(mensaje).toMatchObject({ body: 'Hola', senderId: id.pareja, conversationId: conv })

      const antes = (await request(server).get('/me/conversations').set(como(t.provA)).expect(200))
        .body as BandejaCuerpo
      expect(antes.unreadTotal).toBe(1)
      expect(antes.items[0]).toMatchObject({ id: conv, unreadCount: 1 })
      expect(antes.items[0]?.lastMessage?.body).toBe('Hola')

      await request(server)
        .post(`/conversations/${conv}/read`)
        .set(como(t.provA))
        .send({ upTo: mensaje.id })
        .expect(204)

      const despues = (
        await request(server).get('/me/conversations').set(como(t.provA)).expect(200)
      ).body as BandejaCuerpo
      expect(despues.unreadTotal).toBe(0)
      expect(despues.items[0]?.unreadCount).toBe(0)

      // El emisor ve la marca de lectura del otro.
      const paraEmisor = (
        await request(server).get(`/conversations/${conv}/messages`).set(como(t.pareja)).expect(200)
      ).body as PaginaCuerpo
      expect(paraEmisor.otherMarks.readUpTo?.id).toBe(mensaje.id)
    })

    it('las marcas sólo avanzan y delivered responde 204', async () => {
      const conv = await conversacionEntre(t.pareja, id.provA)
      const enviar = async (body: string) =>
        (
          await request(server)
            .post(`/conversations/${conv}/messages`)
            .set(como(t.pareja))
            .send({ body })
            .expect(201)
        ).body as MensajeCuerpo
      const m1 = await enviar('uno')
      const m2 = await enviar('dos')
      for (const upTo of [m2.id, m1.id]) {
        await request(server)
          .post(`/conversations/${conv}/delivered`)
          .set(como(t.provA))
          .send({ upTo })
          .expect(204)
      }
      const pagina = (
        await request(server).get(`/conversations/${conv}/messages`).set(como(t.pareja)).expect(200)
      ).body as PaginaCuerpo
      expect(pagina.otherMarks.deliveredUpTo?.id).toBe(m2.id)
      expect(pagina.otherMarks.readUpTo).toBeNull()
    })

    it('paginar 120 mensajes en 3 páginas sin repetir', async () => {
      const conv = await conversacionEntre(t.pareja, id.provA)
      const base = Date.now() - 200_000
      await prisma.message.createMany({
        data: Array.from({ length: 120 }, (_, i) => ({
          conversationId: conv,
          senderId: i % 2 === 0 ? id.pareja : id.provA,
          body: `m${i}`,
          createdAt: new Date(base + i * 1000),
        })),
      })

      const vistos: string[] = []
      let cursor: string | null = null
      let paginas = 0
      do {
        const url: string = `/conversations/${conv}/messages?limit=50${
          cursor === null ? '' : `&cursor=${cursor}`
        }`
        const r = (await request(server).get(url).set(como(t.pareja)).expect(200))
          .body as PaginaCuerpo
        vistos.push(...r.items.map((m) => m.id))
        cursor = r.nextCursor
        paginas += 1
      } while (cursor !== null)

      expect(paginas).toBe(3)
      expect(vistos).toHaveLength(120)
      expect(new Set(vistos).size).toBe(120)
    })

    it('un no participante recibe 404 en messages, en enviar y en marcar', async () => {
      const conv = await conversacionEntre(t.pareja, id.provA)
      await request(server).get(`/conversations/${conv}/messages`).set(como(t.provB)).expect(404)
      await request(server).get(`/conversations/${conv}/messages`).set(como(t.admin)).expect(404)
      await request(server)
        .post(`/conversations/${conv}/messages`)
        .set(como(t.provB))
        .send({ body: 'hola' })
        .expect(404)
      await request(server)
        .post(`/conversations/${conv}/read`)
        .set(como(t.provB))
        .send({ upTo: conv })
        .expect(404)
    })

    it('un id mal formado responde 404', async () => {
      await request(server).get('/conversations/xyz/messages').set(como(t.pareja)).expect(404)
      await request(server)
        .post('/conversations/xyz/messages')
        .set(como(t.pareja))
        .send({ body: 'hola' })
        .expect(404)
    })

    it('un cuerpo vacío, en blanco o de más de 2000 caracteres es 400', async () => {
      const conv = await conversacionEntre(t.pareja, id.provA)
      for (const body of ['', '   ', 'x'.repeat(2001)]) {
        await request(server)
          .post(`/conversations/${conv}/messages`)
          .set(como(t.pareja))
          .send({ body })
          .expect(400)
      }
      await request(server)
        .post(`/conversations/${conv}/messages`)
        .set(como(t.pareja))
        .send({ body: 'x'.repeat(2000) })
        .expect(201)
    })

    it('un upTo de otra conversación responde 404', async () => {
      const c1 = await conversacionEntre(t.pareja, id.provA)
      const c2 = await conversacionEntre(t.pareja, id.planner)
      const m = (
        await request(server)
          .post(`/conversations/${c1}/messages`)
          .set(como(t.pareja))
          .send({ body: 'hola' })
          .expect(201)
      ).body as MensajeCuerpo
      await request(server)
        .post(`/conversations/${c2}/read`)
        .set(como(t.planner))
        .send({ upTo: m.id })
        .expect(404)
      await request(server)
        .post(`/conversations/${c2}/delivered`)
        .set(como(t.planner))
        .send({ upTo: 'no-guid' })
        .expect(400)
    })
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

    it('el destinatario recibe message.created al enviar y el emisor recibe message.receipt al leer', async () => {
      const conv = await conversacionEntre(t.pareja, id.provA)
      const socketPareja = await conectarComo(t.pareja)
      const socketProv = await conectarComo(t.provA)
      const recibidosPareja: string[] = []
      socketPareja.onAny((evento: string) => recibidosPareja.push(evento))

      const llega = esperar(socketProv, 'message.created')
      const enviado = await request(server)
        .post(`/conversations/${conv}/messages`)
        .set(como(t.pareja))
        .send({ body: 'hola desde la pareja' })
        .expect(201)
      const mensaje = enviado.body as MensajeCuerpo
      expect(await llega).toEqual({ conversationId: conv, message: mensaje })

      const recibo = esperar(socketPareja, 'message.receipt')
      await request(server)
        .post(`/conversations/${conv}/read`)
        .set(como(t.provA))
        .send({ upTo: mensaje.id })
        .expect(204)
      const marca = { at: mensaje.createdAt, id: mensaje.id }
      expect(await recibo).toEqual({
        conversationId: conv,
        userId: id.provA,
        deliveredUpTo: null,
        readUpTo: marca,
      })
      // El emisor no recibe su propio message.created.
      expect(recibidosPareja).not.toContain('message.created')
    })
  })

  describe('solo lectura', () => {
    it('si el proveedor deja de estar contratado, la pareja lee pero no escribe (403)', async () => {
      const conv = await conversacionEntre(t.pareja, id.provA)
      const m = (
        await request(server)
          .post(`/conversations/${conv}/messages`)
          .set(como(t.provA))
          .send({ body: 'hola' })
          .expect(201)
      ).body as MensajeCuerpo
      await prisma.eventVendor.update({
        where: { id: contratacionA },
        data: { status: 'CANCELLED' },
      })

      const bandeja = (await request(server).get('/me/conversations').set(como(t.pareja)))
        .body as BandejaCuerpo
      expect(bandeja.items[0]).toMatchObject({ id: conv, readOnly: true })
      await request(server).get(`/conversations/${conv}/messages`).set(como(t.pareja)).expect(200)
      await request(server)
        .post(`/conversations/${conv}/messages`)
        .set(como(t.pareja))
        .send({ body: 'sigues ahí?' })
        .expect(403)
      // Marcar sí se permite en solo lectura.
      await request(server)
        .post(`/conversations/${conv}/read`)
        .set(como(t.pareja))
        .send({ upTo: m.id })
        .expect(204)
      // El proveedor que perdió el acceso ya no la ve.
      await request(server).get(`/conversations/${conv}/messages`).set(como(t.provA)).expect(404)
    })

    it('un planner revocado conserva la conversación en solo lectura', async () => {
      const conv = await conversacionEntre(t.pareja, id.planner)
      await prisma.eventMembership.updateMany({
        where: { eventId: eventoId, userId: id.planner },
        data: { status: 'REVOKED' },
      })
      try {
        const r = (await request(server).get('/me/conversations').set(como(t.planner)).expect(200))
          .body as BandejaCuerpo
        expect(r.items[0]).toMatchObject({ id: conv, readOnly: true })
        await request(server)
          .post(`/conversations/${conv}/messages`)
          .set(como(t.planner))
          .send({ body: 'hola' })
          .expect(403)
      } finally {
        await prisma.eventMembership.updateMany({
          where: { eventId: eventoId, userId: id.planner },
          data: { status: 'ACTIVE' },
        })
      }
    })
  })

  it('el límite de ritmo devuelve 429 al mensaje 31', async () => {
    const conv = await conversacionEntre(t.pareja, id.provA)
    const enviar = () =>
      request(server)
        .post(`/conversations/${conv}/messages`)
        .set(como(t.pareja))
        .send({ body: 'hola' })

    for (let i = 0; i < 30; i += 1) await enviar().expect(201)
    await enviar().expect(429)
  })
})
