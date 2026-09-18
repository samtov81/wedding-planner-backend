import type { Server } from 'node:http'
import { inspect } from 'node:util'

import { type INestApplication, type LoggerService } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { Queue } from 'bullmq'
import Redis from 'ioredis'
import request from 'supertest'

import { AppModule } from '@/app.module'
import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { configurarApp, OPCIONES_DE_FABRICA } from '@/configurar-app'
import { generarTokenInvitacion } from '@/modules/guests/domain/invitation'
import { NOTIFICATION_PORT } from '@/modules/notifications/application/notification.port'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { startPostgres, type PostgresDeTest } from '../support/containers'

interface CuerpoError {
  code: string
  message: string
  requestId?: string
}

/**
 * Logger que guarda TODO lo que la aplicación registra, en texto, para poder
 * afirmar que el token no aparece en ninguna línea. `inspect` y no
 * `JSON.stringify`: un `Error` serializa a `{}` en JSON y escondería justo lo
 * que hay que ver.
 */
class RegistroCapturado implements LoggerService {
  readonly lineas: string[] = []
  log(...args: unknown[]): void {
    this.guardar(args)
  }
  error(...args: unknown[]): void {
    this.guardar(args)
  }
  warn(...args: unknown[]): void {
    this.guardar(args)
  }
  debug(...args: unknown[]): void {
    this.guardar(args)
  }
  verbose(...args: unknown[]): void {
    this.guardar(args)
  }
  fatal(...args: unknown[]): void {
    this.guardar(args)
  }
  private guardar(args: unknown[]): void {
    this.lineas.push(inspect(args, { depth: null }))
  }
}

describe('RSVP público e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let redisCli: Redis
  let app: INestApplication
  let server: Server
  let prisma: PrismaClient
  let eventId: string
  let parejaId: string
  let plannerId: string

  const notificaciones = new NotificationPortEnMemoria()
  const registro = new RegistroCapturado()
  /** Cada token que el test ha usado: ninguno puede aparecer en el log. */
  const tokensUsados = new Set<string>()
  const otrasApps: INestApplication[] = []

  /**
   * La app real con el puerto de notificaciones sustituido por su doble, para
   * poder registrar miembros y provocar fallos. Desde la Tarea 15 el módulo
   * cablea el adaptador de Prisma: el rollback con el adaptador REAL está en
   * `realtime.e2e.test.ts`. La cola es la REAL (BullMQ sobre el Redis del test).
   */
  async function crearApp(): Promise<NestExpressApplication> {
    const modulo = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(NOTIFICATION_PORT)
      .useValue(notificaciones)
      .setLogger(registro)
      .compile()
    const nueva = modulo.createNestApplication<NestExpressApplication>({
      ...OPCIONES_DE_FABRICA,
      logger: registro,
    })
    // El arranque de `main.ts`: body parser, CORS, helmet, filtro… (Tarea 16).
    await configurarApp(nueva, nueva.get<Env>(ENV))
    await nueva.init()
    return nueva
  }

  /** Un invitado nuevo con una invitación nueva: ningún test hereda estado de otro. */
  async function invitacion(
    datos: { expiresAt?: Date; status?: 'SENT' | 'DELIVERED' | 'RESPONDED' } = {},
  ): Promise<{ token: string; guestId: string; invitationId: string }> {
    const { token, hash } = generarTokenInvitacion()
    tokensUsados.add(token)
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
        status: datos.status ?? 'DELIVERED',
        expiresAt: datos.expiresAt ?? new Date(Date.now() + 86_400_000),
      },
    })
    return { token, guestId: invitado.id, invitationId: fila.id }
  }

  function tokenInventado(): string {
    const { token } = generarTokenInvitacion()
    tokensUsados.add(token)
    return token
  }

  /** El cuerpo de error sin `requestId`, que es por petición y siempre distinto. */
  function sinRequestId(cuerpo: CuerpoError): Omit<CuerpoError, 'requestId'> {
    return { code: cuerpo.code, message: cuerpo.message }
  }

  /**
   * Los contadores del límite viven en Redis y sobreviven entre tests. Se
   * borran SÓLO los de los limitadores (no un FLUSHDB, que se llevaría las
   * colas de BullMQ del worker que está corriendo).
   */
  async function reiniciarLimites(): Promise<void> {
    const claves = [...(await redisCli.keys('*:rsvp}:*')), ...(await redisCli.keys('*:global}:*'))]
    if (claves.length > 0) await redisCli.del(...claves)
  }

  /** El job que el caso de uso deja en la cola `notifications` para el worker de la Tarea 15. */
  async function jobDeAviso(invitationId: string): Promise<unknown> {
    const cola = new Queue('notifications', { connection: { url: redis.getConnectionUrl() } })
    try {
      const job = await cola.getJob(`rsvp-${invitationId}`)
      return job === undefined ? undefined : { name: job.name, data: job.data as unknown }
    } finally {
      await cola.close()
    }
  }

  function espiarCola() {
    return vi.spyOn(app.get<QueuePort>(QUEUE_PORT), 'enqueue')
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

    app = await crearApp()
    server = app.getHttpServer() as Server
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    redisCli = new Redis(redis.getConnectionUrl())

    const pareja = await prisma.user.create({
      data: { email: 'pareja@test.com', passwordHash: 'x', fullName: 'Pareja' },
    })
    const planner = await prisma.user.create({
      data: { email: 'planner@test.com', passwordHash: 'x', fullName: 'Planner' },
    })
    const evento = await prisma.event.create({
      data: {
        name: 'Boda de Ana',
        weddingDate: new Date(Date.UTC(2027, 5, 12)),
        ownerId: pareja.id,
      },
    })
    await prisma.eventMembership.createMany({
      data: [
        { eventId: evento.id, userId: pareja.id, role: 'COUPLE' },
        { eventId: evento.id, userId: planner.id, role: 'PLANNER' },
      ],
    })
    eventId = evento.id
    parejaId = pareja.id
    plannerId = planner.id
    notificaciones.registrarMiembros(eventId, [parejaId, plannerId])
  }, 240_000)

  beforeEach(async () => {
    await reiniciarLimites()
  })

  afterAll(async () => {
    for (const otra of otrasApps) await otra.close()
    redisCli.disconnect()
    await prisma.$disconnect()
    await app.close()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  describe('GET /rsvp/:token', () => {
    it('sin sesión, devuelve EXACTAMENTE la vista pública', async () => {
      // Ni cabecera Authorization ni cookie: la credencial es el token.
      const { token } = await invitacion()

      const respuesta = await request(server).get(`/rsvp/${token}`).expect(200)

      // `toEqual` sobre el cuerpo entero: un id, un correo o un campo del
      // evento de más rompen el test.
      expect(respuesta.body).toEqual({
        guestName: 'Ana Invitada',
        eventName: 'Boda de Ana',
        weddingDate: '2027-06-12T00:00:00.000Z',
        rsvp: 'PENDING',
        dietary: null,
      })
    })
  })

  describe('POST /rsvp/:token', () => {
    it('persiste la respuesta, gasta el token y avisa a los miembros', async () => {
      const { token, guestId, invitationId } = await invitacion()
      const creadasAntes = notificaciones.creadas.length

      await request(server)
        .post(`/rsvp/${token}`)
        .send({ rsvp: 'CONFIRMED', dietary: 'Vegan' })
        .expect(204)

      const invitado = await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })
      expect(invitado.rsvp).toBe('CONFIRMED')
      expect(invitado.dietary).toBe('Vegan')
      const fila = await prisma.guestInvitation.findUniqueOrThrow({ where: { id: invitationId } })
      expect(fila.status).toBe('RESPONDED')
      expect(fila.respondedAt).toBeInstanceOf(Date)
      expect(
        notificaciones.creadas
          .slice(creadasAntes)
          .map((n) => n.userId)
          .sort(),
      ).toEqual([parejaId, plannerId].sort())
      // El aviso en tiempo real se ENCOLA (C23): lo emite el worker de la Tarea 15.
      expect(await jobDeAviso(invitationId)).toEqual({
        name: 'guest.rsvp.updated',
        data: { eventId, payload: { guestId, guestName: 'Ana Invitada', rsvp: 'CONFIRMED' } },
      })
    })

    it('el token es de un solo uso: la segunda respuesta no se escribe', async () => {
      const { token, guestId } = await invitacion()
      await request(server).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(204)

      await request(server).post(`/rsvp/${token}`).send({ rsvp: 'DECLINED' }).expect(404)

      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'CONFIRMED',
      )
    })

    it('un cuerpo inválido es un 400 que no gasta el token', async () => {
      const { token, guestId } = await invitacion()

      await request(server).post(`/rsvp/${token}`).send({ rsvp: 'PENDING' }).expect(400)
      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'PENDING',
      )

      await request(server).post(`/rsvp/${token}`).send({ rsvp: 'DECLINED' }).expect(204)
    })

    it('si falla una escritura, no se confirma NADA y el token sigue sirviendo', async () => {
      // Invitación, invitado y notificaciones en UNA transacción de Postgres:
      // si las notificaciones fallan, la invitación no puede quedar RESPONDED
      // (el invitado ya no podría contestar) con el invitado aún PENDING.
      const { token, guestId, invitationId } = await invitacion()
      notificaciones.fallarProximaCreacion(new Error('fallo al crear notificaciones'))

      const fallo = await request(server).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' })

      expect(fallo.status).toBe(500)
      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'PENDING',
      )
      const fila = await prisma.guestInvitation.findUniqueOrThrow({ where: { id: invitationId } })
      expect(fila.status).toBe('DELIVERED')
      expect(fila.respondedAt).toBeNull()

      await request(server).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(204)
    })

    it('si encolar el aviso falla, la respuesta ya está persistida y el invitado ve 204', async () => {
      const { token, guestId, invitationId } = await invitacion()
      const espia = espiarCola().mockRejectedValueOnce(new Error('redis caído'))

      await request(server).post(`/rsvp/${token}`).send({ rsvp: 'DECLINED' }).expect(204)
      espia.mockRestore()

      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'DECLINED',
      )
      const fila = await prisma.guestInvitation.findUniqueOrThrow({ where: { id: invitationId } })
      expect(fila.status).toBe('RESPONDED')
      expect(await jobDeAviso(invitationId)).toBeUndefined()
    })

    it('dos respuestas simultáneas con el mismo token: Postgres deja pasar sólo una', async () => {
      // Ambas leen la invitación válida; decide el UPDATE condicionado. Este
      // test no puede forzar el entrelazado: con la guarda es siempre verde,
      // sin ella es rojo casi siempre. La prueba determinista está en los
      // tests del caso de uso y del repositorio.
      const { token, guestId } = await invitacion()
      const creadasAntes = notificaciones.creadas.length
      const intentos = ['CONFIRMED', 'DECLINED'] as const

      const respuestas = await Promise.all(
        intentos.map((rsvp) => request(server).post(`/rsvp/${token}`).send({ rsvp })),
      )

      expect(respuestas.map((r) => r.status).sort()).toEqual([204, 404])
      const ganadora = intentos[respuestas.findIndex((r) => r.status === 204)]
      const invitado = await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })
      expect(invitado.rsvp).toBe(ganadora)
      // Un solo juego de notificaciones: la perdedora no llegó a escribir nada.
      expect(notificaciones.creadas.length - creadasAntes).toBe(2)
    })
  })

  describe('todo fallo de token es indistinguible', () => {
    /**
     * Inexistente, mal formado, caducado, caducado por el worker (C18) y ya
     * usado: MISMO status, MISMO code, MISMO mensaje, en las dos rutas.
     */
    async function tokensQueFallan(): Promise<Array<[string, string]>> {
      const caducado = await invitacion({ expiresAt: new Date(Date.now() - 1000) })
      const caducadoPorElWorker = await invitacion()
      await prisma.guestInvitation.update({
        where: { id: caducadoPorElWorker.invitationId },
        data: { expiresAt: new Date() },
      })
      const usado = await invitacion({ status: 'RESPONDED' })

      return [
        ['inexistente', tokenInventado()],
        ['mal formado', 'no-es-un-token'],
        ['caducado', caducado.token],
        ['caducado por el worker (C18)', caducadoPorElWorker.token],
        ['ya usado', usado.token],
      ]
    }

    it('GET: el mismo 404 para todos', async () => {
      const casos = await tokensQueFallan()

      const cuerpos = []
      for (const [, token] of casos) {
        const respuesta = await request(server).get(`/rsvp/${token}`)
        expect(respuesta.status).toBe(404)
        cuerpos.push(sinRequestId(respuesta.body as CuerpoError))
      }

      expect(cuerpos[0]?.code).toBe('INVITATION_INVALID')
      for (const cuerpo of cuerpos) expect(cuerpo).toEqual(cuerpos[0])
    })

    it('POST: el mismo 404 para todos, y ninguno escribe nada', async () => {
      const casos = await tokensQueFallan()
      const creadasAntes = notificaciones.creadas.length

      const cuerpos = []
      for (const [, token] of casos) {
        const respuesta = await request(server).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' })
        expect(respuesta.status).toBe(404)
        cuerpos.push(sinRequestId(respuesta.body as CuerpoError))
      }

      expect(cuerpos[0]?.code).toBe('INVITATION_INVALID')
      for (const cuerpo of cuerpos) expect(cuerpo).toEqual(cuerpos[0])
      expect(notificaciones.creadas.length).toBe(creadasAntes)
    })
  })

  describe('límite de ritmo', () => {
    it('POST: el sexto intento en un minuto desde la misma IP es un 429', async () => {
      for (let i = 0; i < 5; i += 1) {
        await request(server)
          .post(`/rsvp/${tokenInventado()}`)
          .send({ rsvp: 'CONFIRMED' })
          .expect(404)
      }

      await request(server)
        .post(`/rsvp/${tokenInventado()}`)
        .send({ rsvp: 'CONFIRMED' })
        .expect(429)
    })

    it('el límite corta también un token VÁLIDO: se aplica antes de mirar el token', async () => {
      const { token } = await invitacion()
      for (let i = 0; i < 5; i += 1) {
        await request(server).post(`/rsvp/${tokenInventado()}`).send({ rsvp: 'CONFIRMED' })
      }

      await request(server).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(429)
    })

    it('GET: 20 por minuto; el 21 es un 429', async () => {
      for (let i = 0; i < 20; i += 1) {
        await request(server).get(`/rsvp/${tokenInventado()}`).expect(404)
      }

      await request(server).get(`/rsvp/${tokenInventado()}`).expect(429)
    })

    it('el contador vive en Redis: dos instancias comparten el mismo límite', async () => {
      // Con el almacén en memoria por defecto de `@nestjs/throttler`, cada
      // instancia contaría sus 5 y el límite real sería 5 × instancias.
      const otra = await crearApp()
      otrasApps.push(otra)
      const otroServidor = otra.getHttpServer()

      for (let i = 0; i < 3; i += 1) {
        await request(server)
          .post(`/rsvp/${tokenInventado()}`)
          .send({ rsvp: 'CONFIRMED' })
          .expect(404)
      }
      for (let i = 0; i < 2; i += 1) {
        await request(otroServidor)
          .post(`/rsvp/${tokenInventado()}`)
          .send({ rsvp: 'CONFIRMED' })
          .expect(404)
      }

      await request(otroServidor)
        .post(`/rsvp/${tokenInventado()}`)
        .send({ rsvp: 'CONFIRMED' })
        .expect(429)
    })

    it('el RSVP lleva su límite Y el global; el de login no cae sobre él (C22)', async () => {
      const lectura = await request(server).get(`/rsvp/${tokenInventado()}`).expect(404)
      expect(lectura.headers['x-ratelimit-limit-rsvp']).toBe('20')
      expect(lectura.headers['x-ratelimit-limit-global']).toBe('120')
      expect(lectura.headers['x-ratelimit-limit-login']).toBeUndefined()

      const respuesta = await request(server)
        .post(`/rsvp/${tokenInventado()}`)
        .send({ rsvp: 'CONFIRMED' })
        .expect(404)
      expect(respuesta.headers['x-ratelimit-limit-rsvp']).toBe('5')
      expect(respuesta.headers['x-ratelimit-limit-global']).toBe('120')
    })

    it('las demás rutas sin sesión llevan el global, y no el límite del RSVP (C22)', async () => {
      // `register` enumera cuentas vía 409 y `refresh` acepta un secreto: sin
      // límite propio, el global es su único suelo.
      const registro = await request(server)
        .post('/auth/register')
        .send({ email: 'alguien@test.com', password: 'una-contraseña-larga', fullName: 'Alguien' })
        .expect(201)
      expect(registro.headers['x-ratelimit-limit-global']).toBe('120')
      expect(registro.headers['x-ratelimit-limit-rsvp']).toBeUndefined()
      expect(registro.headers['x-ratelimit-limit-login']).toBeUndefined()

      const refresco = await request(server).post('/auth/refresh').expect(401)
      expect(refresco.headers['x-ratelimit-limit-global']).toBe('120')
      expect(refresco.headers['x-ratelimit-limit-rsvp']).toBeUndefined()
    })
  })

  describe('el token nunca llega al log', () => {
    it('ni en un 404, ni en un 400, ni en un 500, ni en el aviso de la cola, ni en un 429', async () => {
      const valido = await invitacion()
      const otro = await invitacion()
      registro.lineas.length = 0

      await request(server).get(`/rsvp/${tokenInventado()}`).expect(404)
      await request(server).post(`/rsvp/${valido.token}`).send({ rsvp: 'MAYBE' }).expect(400)
      notificaciones.fallarProximaCreacion(new Error('fallo al crear notificaciones'))
      await request(server).post(`/rsvp/${valido.token}`).send({ rsvp: 'CONFIRMED' }).expect(500)
      const espia = espiarCola().mockRejectedValueOnce(new Error('redis caído'))
      await request(server).post(`/rsvp/${otro.token}`).send({ rsvp: 'CONFIRMED' }).expect(204)
      espia.mockRestore()
      for (let i = 0; i < 3; i += 1) {
        await request(server).post(`/rsvp/${tokenInventado()}`).send({ rsvp: 'CONFIRMED' })
      }
      const cortado = await request(server)
        .post(`/rsvp/${valido.token}`)
        .send({ rsvp: 'CONFIRMED' })
        .expect(429)

      const todo = registro.lineas.join('\n')
      for (const token of tokensUsados) expect(todo).not.toContain(token)
      // El test no puede ser verde por no registrar nada: el 500 y el fallo
      // al encolar SÍ tienen que estar en el log, sin el token.
      expect(todo).toContain('/rsvp/[REDACTADO]')
      expect(todo).toContain('RSVP persistido pero su aviso no se pudo encolar')
      // Ni el 429 lo devuelve al cliente.
      expect(JSON.stringify(cortado.body)).not.toContain(valido.token)
    })
  })
})
