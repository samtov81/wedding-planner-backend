import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import cookieParser from 'cookie-parser'
import Redis from 'ioredis'
import { io, type Socket as SocketCliente } from 'socket.io-client'
import request from 'supertest'
import { Webhook } from 'svix'

import { AppModule } from '@/app.module'
import { TokenService } from '@/modules/auth/application/token.service'
import { generarTokenInvitacion } from '@/modules/guests/domain/invitation'
import {
  NOTIFICATION_PORT,
  type NotificationPort,
} from '@/modules/notifications/application/notification.port'
import { RedisIoAdapter } from '@/modules/notifications/infrastructure/redis-io.adapter'
import { DomainExceptionFilter } from '@/shared/http/domain-exception.filter'

import { startPostgres, type PostgresDeTest } from '../support/containers'

const SECRETO_WEBHOOK = `whsec_${Buffer.from('secreto-e2e-del-webhook-32-bytes').toString('base64')}`

interface Participante {
  id: string
  accessToken: string
}

interface CuerpoNotificaciones {
  items: Array<{ id: string; type: string; payload: unknown; readAt: string | null }>
  nextCursor: string | null
  unreadCount: number
}

/**
 * El flujo completo, con TODO real: Postgres, Redis, BullMQ, el worker de
 * `notifications`, el adaptador de Prisma de las notificaciones (sin dobles),
 * el emitter de Socket.IO y `RedisIoAdapter` en el servidor, como en `main.ts`.
 */
describe('Tiempo real e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let app: INestApplication
  let otraInstancia: INestApplication
  let prisma: PrismaClient
  let eventId: string
  let pareja: Participante
  let planner: Participante
  let vendor: Participante
  let extraño: Participante
  const abiertos: SocketCliente[] = []

  /** Una instancia de la API como la arranca `main.ts`, escuchando en un puerto libre. */
  async function arrancarInstancia(): Promise<{ app: INestApplication; url: string }> {
    const nueva = await NestFactory.create(AppModule, { logger: false, rawBody: true })
    nueva.use(cookieParser())
    nueva.useGlobalFilters(new DomainExceptionFilter())
    const sockets = new RedisIoAdapter(nueva)
    await sockets.conectar(redis.getConnectionUrl())
    nueva.useWebSocketAdapter(sockets)
    await nueva.listen(0, '127.0.0.1')
    const { port } = (nueva.getHttpServer() as { address: () => AddressInfo }).address()
    return { app: nueva, url: `http://127.0.0.1:${port}` }
  }

  let urlA: string
  let urlB: string

  /** El servidor HTTP de la instancia A, ya tipado para supertest. */
  function http(): Server {
    return app.getHttpServer() as Server
  }

  async function participante(email: string): Promise<Participante> {
    const usuario = await prisma.user.create({
      data: { email, passwordHash: 'x', fullName: email },
    })
    const accessToken = app
      .get(TokenService)
      .firmarAccess({ id: usuario.id, systemRole: usuario.systemRole })
    return { id: usuario.id, accessToken }
  }

  async function conectarComo(quien: Participante, url = urlA): Promise<SocketCliente> {
    const socket = io(`${url}/realtime`, {
      auth: { token: quien.accessToken },
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

  async function unirse(socket: SocketCliente): Promise<unknown> {
    return (await socket.timeout(5_000).emitWithAck('join', { eventId })) as unknown
  }

  function esperarEvento(socket: SocketCliente, evento: string, ms = 10_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const reloj = setTimeout(() => reject(new Error(`no llegó ${evento} en ${ms} ms`)), ms)
      socket.once(evento, (datos: unknown) => {
        clearTimeout(reloj)
        resolve(datos)
      })
    })
  }

  /** Registra TODO lo que un socket recibe, para afirmar lo que NO le llegó. */
  function grabar(socket: SocketCliente): Array<[string, unknown]> {
    const recibidos: Array<[string, unknown]> = []
    socket.onAny((evento: string, datos: unknown) => recibidos.push([evento, datos]))
    return recibidos
  }

  async function invitacion(): Promise<{ token: string; guestId: string; invitationId: string }> {
    const { token, hash } = generarTokenInvitacion()
    const invitado = await prisma.guest.create({
      data: {
        eventId,
        name: 'Ana Invitada',
        email: `ana-${hash.slice(0, 8)}@test.com`,
        group: 'Family',
      },
    })
    const fila = await prisma.guestInvitation.create({
      data: {
        guestId: invitado.id,
        tokenHash: hash,
        status: 'DELIVERED',
        resendMessageId: `re_${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    return { token, guestId: invitado.id, invitationId: fila.id }
  }

  function notificacionesDe(quien: Participante, query = ''): request.Test {
    return request(http())
      .get(`/events/${eventId}/notifications${query}`)
      .set('Authorization', `Bearer ${quien.accessToken}`)
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()

    process.env.NODE_ENV = 'test'
    process.env.DATABASE_URL = pg.url
    process.env.REDIS_URL = redis.getConnectionUrl()
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(32)
    process.env.JWT_ACCESS_TTL = '15m'
    process.env.REFRESH_TTL_DAYS = '30'
    process.env.MAIL_DRIVER = 'fake'
    process.env.APP_URL = 'http://localhost:5173'
    process.env.RESEND_WEBHOOK_SECRET = SECRETO_WEBHOOK

    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    ;({ app, url: urlA } = await arrancarInstancia())
    ;({ app: otraInstancia, url: urlB } = await arrancarInstancia())

    pareja = await participante('pareja@test.com')
    planner = await participante('planner@test.com')
    vendor = await participante('vendor@test.com')
    extraño = await participante('extrano@test.com')

    const evento = await prisma.event.create({
      data: {
        name: 'Boda de Ana',
        // Relativa a hoy: el POST del RSVP exige `ahora < cierre` (bloque A §2),
        // y una fecha fija dejaría los 204 de este fichero en 422 al pasarla.
        weddingDate: new Date(Date.now() + 180 * 86_400_000),
        ownerId: pareja.id,
      },
    })
    eventId = evento.id
    await prisma.eventMembership.createMany({
      data: [
        { eventId, userId: pareja.id, role: 'COUPLE' },
        { eventId, userId: planner.id, role: 'PLANNER' },
      ],
    })
    const perfil = await prisma.vendorProfile.create({
      data: { userId: vendor.id, businessName: 'Catering', category: 'CATERING' },
    })
    await prisma.eventVendor.create({
      data: { eventId, vendorProfileId: perfil.id, category: 'CATERING', status: 'BOOKED' },
    })
  }, 240_000)

  /**
   * El POST del RSVP tiene su límite de 5/min por IP y aquí se responden más.
   * Se borran SÓLO los contadores de los limitadores (un FLUSHDB se llevaría
   * las colas de BullMQ del worker que está corriendo).
   */
  beforeEach(async () => {
    const cli = new Redis(redis.getConnectionUrl())
    try {
      const claves = [...(await cli.keys('*:rsvp}:*')), ...(await cli.keys('*:global}:*'))]
      if (claves.length > 0) await cli.del(...claves)
    } finally {
      cli.disconnect()
    }
  })

  afterEach(() => {
    for (const socket of abiertos.splice(0)) socket.disconnect()
  })

  afterAll(async () => {
    delete process.env.RESEND_WEBHOOK_SECRET
    await prisma.$disconnect()
    await otraInstancia.close()
    await app.close()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('responder un RSVP notifica a la pareja por socket y queda persistido', async () => {
    const { token, guestId } = await invitacion()
    const socket = await conectarComo(pareja)
    expect(await unirse(socket)).toEqual({ ok: true })

    const recibido = esperarEvento(socket, 'guest.rsvp.updated')
    const aviso = esperarEvento(socket, 'notification.created')

    await request(http()).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(204)

    expect(await recibido).toEqual({ guestId, guestName: 'Ana Invitada', rsvp: 'CONFIRMED' })
    expect(await aviso).toEqual({ eventId, type: 'guest.rsvp.updated' })
    const filas = await prisma.notification.findMany({
      where: { eventId, payload: { path: ['guestId'], equals: guestId } },
    })
    expect(filas.map((f) => f.userId).sort()).toEqual([pareja.id, planner.id].sort())
  })

  it('llega aunque el socket esté en OTRA instancia: el fan-out pasa por Redis', async () => {
    const { token, guestId } = await invitacion()
    const socket = await conectarComo(planner, urlB)
    await unirse(socket)

    const recibido = esperarEvento(socket, 'guest.rsvp.updated')
    await request(http()).post(`/rsvp/${token}`).send({ rsvp: 'DECLINED' }).expect(204)

    expect(await recibido).toMatchObject({ guestId, rsvp: 'DECLINED' })
  })

  it('un vendor en el evento y un extraño no oyen el RSVP; ni siquiera notification.created', async () => {
    const { token } = await invitacion()
    const deLaPareja = await conectarComo(pareja)
    await unirse(deLaPareja)
    const delVendor = await conectarComo(vendor)
    expect(await unirse(delVendor)).toEqual({ ok: true })
    const delExtraño = await conectarComo(extraño)
    expect(await unirse(delExtraño)).toEqual({ ok: false, code: 'NOT_FOUND' })
    const oidoPorVendor = grabar(delVendor)
    const oidoPorExtraño = grabar(delExtraño)

    const recibido = esperarEvento(deLaPareja, 'notification.created')
    await request(http()).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(204)
    await recibido
    // Margen para que un emit indebido, publicado en el mismo lote, llegara.
    await new Promise((r) => setTimeout(r, 300))

    expect(oidoPorVendor).toEqual([])
    expect(oidoPorExtraño).toEqual([])
  })

  it('un cliente desconectado recupera por REST lo que se perdió', async () => {
    // La propiedad que define el diseño: el socket es latencia, no el canal.
    const { token, guestId } = await invitacion()
    await request(http()).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(204)

    const { body } = (await notificacionesDe(pareja).expect(200)) as { body: CuerpoNotificaciones }

    expect(body.items).toContainEqual(
      expect.objectContaining({
        type: 'guest.rsvp.updated',
        payload: { guestId, guestName: 'Ana Invitada', rsvp: 'CONFIRMED' },
        readAt: null,
      }),
    )
    expect(body.unreadCount).toBe(body.items.filter((n) => n.readAt === null).length)
  })

  it('marcar como leída: idempotente, baja el total, y la de otro es 404', async () => {
    const { token } = await invitacion()
    await request(http()).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(204)
    const antes = ((await notificacionesDe(pareja).expect(200)) as { body: CuerpoNotificaciones })
      .body
    const primera = antes.items[0]
    if (primera === undefined) throw new Error('sin notificaciones')
    const dePlanner = (
      (await notificacionesDe(planner).expect(200)) as { body: CuerpoNotificaciones }
    ).body.items[0]

    const marcar = (id: string) =>
      request(http())
        .post(`/events/${eventId}/notifications/${id}/read`)
        .set('Authorization', `Bearer ${pareja.accessToken}`)
    await marcar(primera.id).expect(204)
    await marcar(primera.id).expect(204)
    await marcar(dePlanner?.id ?? randomUUID()).expect(404)
    await marcar('no-es-un-uuid').expect(404)

    const despues = (
      (await notificacionesDe(pareja, '?unread=true').expect(200)) as {
        body: CuerpoNotificaciones
      }
    ).body
    expect(despues.unreadCount).toBe(antes.unreadCount - 1)
    expect(despues.items.map((n) => n.id)).not.toContain(primera.id)
  })

  it('el REST de notificaciones autoriza como el resto: vendor 403, extraño 404, sin token 401', async () => {
    await notificacionesDe(vendor).expect(403)
    await notificacionesDe(extraño).expect(404)
    await request(http()).get(`/events/${eventId}/notifications`).expect(401)
  })

  it('si falla algo DESPUÉS de escribir las notificaciones, se deshacen con el RSVP', async () => {
    // El adaptador REAL escribe dentro de la unidad de trabajo del RSVP
    // (`clienteDe`). Se deja que escriba y se falla justo después: si hubiera
    // escrito por su propia conexión, sus filas sobrevivirían al rollback.
    const { token, guestId, invitationId } = await invitacion()
    const puerto = app.get<NotificationPort>(NOTIFICATION_PORT)
    const original = puerto.crearParaMiembros.bind(puerto)
    const espia = vi.spyOn(puerto, 'crearParaMiembros').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('fallo después de notificar')
    })

    const fallo = await request(http()).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' })
    espia.mockRestore()

    expect(fallo.status).toBe(500)
    const notificaciones = await prisma.notification.findMany({
      where: { eventId, payload: { path: ['guestId'], equals: guestId } },
    })
    expect(notificaciones).toEqual([])
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe('PENDING')
    expect(
      (await prisma.guestInvitation.findUniqueOrThrow({ where: { id: invitationId } })).status,
    ).toBe('DELIVERED')

    // Y el token sigue sirviendo: ahora sí, con sus dos notificaciones.
    await request(http()).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(204)
    expect(
      await prisma.notification.count({
        where: { eventId, payload: { path: ['guestId'], equals: guestId } },
      }),
    ).toBe(2)
  })

  it('un rebote que llega por el webhook se avisa como guest.invitation.status', async () => {
    const { guestId, invitationId } = await invitacion()
    const { resendMessageId } = await prisma.guestInvitation.update({
      where: { id: invitationId },
      data: { status: 'SENT' },
    })
    const socket = await conectarComo(planner)
    await unirse(socket)
    const recibido = esperarEvento(socket, 'guest.invitation.status')

    const cuerpo = JSON.stringify({
      created_at: new Date().toISOString(),
      type: 'email.bounced',
      data: { email_id: resendMessageId, to: ['x@test.com'] },
    })
    const id = `msg_${randomUUID()}`
    const ahora = new Date()
    await request(http())
      .post('/webhooks/resend')
      .set('Content-Type', 'application/json')
      .set({
        'svix-id': id,
        'svix-timestamp': String(Math.floor(ahora.getTime() / 1000)),
        'svix-signature': new Webhook(SECRETO_WEBHOOK).sign(id, ahora, cuerpo),
      })
      .send(cuerpo)
      .expect(204)

    expect(await recibido).toEqual({ guestId, invitationId, status: 'BOUNCED' })
  })
})
