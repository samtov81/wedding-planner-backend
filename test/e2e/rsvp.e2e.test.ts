import { inspect } from 'node:util'

import { type LoggerService } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { Queue } from 'bullmq'
import request from 'supertest'

import { AppModule } from '@/app.module'
import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { configurarApp, OPCIONES_DE_FABRICA } from '@/configurar-app'
import { SendSingleInvitationUseCase } from '@/modules/guests/application/send-single-invitation.use-case'
import { UpdateGuestUseCase } from '@/modules/guests/application/update-guest.use-case'
import { generarTokenInvitacion } from '@/modules/guests/domain/invitation'
import { NOTIFICATION_PORT } from '@/modules/notifications/application/notification.port'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { limpiarContadoresDeRitmo } from '../support/throttler'

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

const DIA_MS = 86_400_000
/**
 * La boda del evento compartido, relativa a hoy: desde el bloque A §2 el POST
 * depende de `ahora < cierre`, y una fecha fija haría que la suite entera
 * empezara a dar 422 el día que el calendario pasara el cierre.
 */
const BODA = new Date(Date.now() + 180 * DIA_MS)
/** El cierre con el plazo por defecto (14 días). */
const CIERRE = new Date(BODA.getTime() - 14 * DIA_MS)

describe('RSVP público e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let app: NestExpressApplication
  let url: string
  let prisma: PrismaClient
  let eventId: string
  let parejaId: string
  let plannerId: string

  const notificaciones = new NotificationPortEnMemoria()
  const registro = new RegistroCapturado()
  /** Cada token que el test ha usado: ninguno puede aparecer en el log. */
  const tokensUsados = new Set<string>()
  const otrasApps: NestExpressApplication[] = []

  /**
   * La app real con el puerto de notificaciones sustituido por su doble, para
   * poder registrar miembros y provocar fallos. Desde la Tarea 15 el módulo
   * cablea el adaptador de Prisma: el rollback con el adaptador REAL está en
   * `realtime.e2e.test.ts`. La cola es la REAL (BullMQ sobre el Redis del test).
   *
   * Escucha de verdad (`listen(0)`), como `arrancarAppDeTest` en
   * `test/support/app.ts`: no se puede reutilizar ese helper porque aquí el
   * módulo lleva `overrideProvider` y un logger propio, pero la razón para
   * escuchar es la misma — un servidor que no escucha hace que supertest abra
   * un puerto efímero por petición.
   */
  async function crearApp(): Promise<{ app: NestExpressApplication; url: string }> {
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
    await nueva.listen(0, '127.0.0.1')
    const suUrl = (await nueva.getUrl()).replace('[::1]', '127.0.0.1')
    return { app: nueva, url: suUrl }
  }

  /**
   * Un invitado nuevo con una invitación nueva: ningún test hereda estado de
   * otro. Por defecto, del evento compartido (`BODA`, cierre `CIERRE`);
   * `eventId` para colgarlo de un evento propio.
   */
  async function invitacion(
    datos: {
      expiresAt?: Date
      status?: 'SENT' | 'DELIVERED' | 'RESPONDED'
      eventId?: string
    } = {},
  ): Promise<{ token: string; guestId: string; invitationId: string }> {
    const { token, hash } = generarTokenInvitacion()
    tokensUsados.add(token)
    const invitado = await prisma.guest.create({
      data: {
        eventId: datos.eventId ?? eventId,
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
   * Los jobs que el caso de uso deja en la cola `notifications` para el worker
   * de la Tarea 15, uno por respuesta: su id es `rsvp-<invitationId>-<epochMs>`
   * (bloque A §2), así que se buscan por prefijo en todos los estados.
   */
  async function jobsDeAviso(invitationId: string): Promise<unknown[]> {
    const cola = new Queue('notifications', { connection: { url: redis.getConnectionUrl() } })
    try {
      const jobs = await cola.getJobs([
        'waiting',
        'active',
        'delayed',
        'prioritized',
        'completed',
        'failed',
      ])
      return jobs
        .filter((job) => job.id?.startsWith(`rsvp-${invitationId}-`) === true)
        .map((job) => ({ name: job.name, data: job.data as unknown }))
    } finally {
      await cola.close()
    }
  }

  /** Un evento propio con la boda a `dias` días de hoy y el plazo por defecto (14). */
  async function eventoConBodaEn(dias: number): Promise<string> {
    const evento = await prisma.event.create({
      data: {
        name: 'Boda inminente',
        weddingDate: new Date(Date.now() + dias * DIA_MS),
        ownerId: parejaId,
      },
    })
    return evento.id
  }

  function espiarCola() {
    return vi.spyOn(app.get<QueuePort>(QUEUE_PORT), 'enqueue')
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ app, url } = await crearApp())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    const pareja = await prisma.user.create({
      data: { email: 'pareja@test.com', passwordHash: 'x', fullName: 'Pareja' },
    })
    const planner = await prisma.user.create({
      data: { email: 'planner@test.com', passwordHash: 'x', fullName: 'Planner' },
    })
    const evento = await prisma.event.create({
      data: {
        name: 'Boda de Ana',
        weddingDate: BODA,
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
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
  })

  afterAll(async () => {
    for (const otra of otrasApps) await otra.close()
    await prisma.$disconnect()
    await app.close()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  describe('GET /rsvp/:token', () => {
    it('sin sesión, devuelve EXACTAMENTE la vista pública', async () => {
      // Ni cabecera Authorization ni cookie: la credencial es el token.
      const { token } = await invitacion()

      const respuesta = await request(url).get(`/rsvp/${token}`).expect(200)

      // `toEqual` sobre el cuerpo entero: un id, un correo o un campo del
      // evento de más rompen el test.
      expect(respuesta.body).toEqual({
        guestName: 'Ana Invitada',
        eventName: 'Boda de Ana',
        weddingDate: BODA.toISOString(),
        rsvp: 'PENDING',
        dietary: null,
        rsvpClosesAt: CIERRE.toISOString(),
      })
    })

    it('tras responder, el mismo token sigue leyendo: la respuesta actual y el cierre', async () => {
      const { token } = await invitacion()
      await request(url)
        .post(`/rsvp/${token}`)
        .send({ rsvp: 'CONFIRMED', dietary: 'Vegan' })
        .expect(204)

      const respuesta = await request(url).get(`/rsvp/${token}`).expect(200)

      expect(respuesta.body).toMatchObject({
        rsvp: 'CONFIRMED',
        dietary: 'Vegan',
        rsvpClosesAt: CIERRE.toISOString(),
      })
    })
  })

  describe('POST /rsvp/:token', () => {
    it('persiste la respuesta, gasta el token y avisa a los miembros', async () => {
      const { token, guestId, invitationId } = await invitacion()
      const creadasAntes = notificaciones.creadas.length

      await request(url)
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
      expect(await jobsDeAviso(invitationId)).toEqual([
        {
          name: 'guest.rsvp.updated',
          data: { eventId, payload: { guestId, guestName: 'Ana Invitada', rsvp: 'CONFIRMED' } },
        },
      ])
    })

    it('se puede cambiar la respuesta antes del cierre, y cada cambio encola su aviso', async () => {
      const { token, guestId, invitationId } = await invitacion()

      await request(url).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(204)
      await request(url).post(`/rsvp/${token}`).send({ rsvp: 'DECLINED' }).expect(204)

      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'DECLINED',
      )
      // Con el jobId de antes (`rsvp-<invitationId>`) BullMQ descartaba el segundo.
      const avisos = (await jobsDeAviso(invitationId)) as Array<{
        name: string
        data: { payload: { rsvp: string } }
      }>
      expect(avisos.map((a) => a.name)).toEqual(['guest.rsvp.updated', 'guest.rsvp.updated'])
      expect(avisos.map((a) => a.data.payload.rsvp).sort()).toEqual(['CONFIRMED', 'DECLINED'])
    })

    it('pasado el cierre, POST es un 422 RSVP_CLOSED que no escribe; GET sigue dando 200', async () => {
      // Boda a 3 días con el plazo por defecto de 14: el cierre fue hace 11.
      const { token, guestId, invitationId } = await invitacion({
        eventId: await eventoConBodaEn(3),
      })

      const rechazo = await request(url)
        .post(`/rsvp/${token}`)
        .send({ rsvp: 'CONFIRMED' })
        .expect(422)

      expect((rechazo.body as CuerpoError).code).toBe('RSVP_CLOSED')
      expect(JSON.stringify(rechazo.body)).not.toContain(token)
      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'PENDING',
      )
      expect(
        (await prisma.guestInvitation.findUniqueOrThrow({ where: { id: invitationId } })).status,
      ).toBe('DELIVERED')
      const lectura = await request(url).get(`/rsvp/${token}`).expect(200)
      expect((lectura.body as { rsvp: string }).rsvp).toBe('PENDING')
    })

    it('un cuerpo inválido es un 400 que no gasta el token', async () => {
      const { token, guestId } = await invitacion()

      await request(url).post(`/rsvp/${token}`).send({ rsvp: 'PENDING' }).expect(400)
      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'PENDING',
      )

      await request(url).post(`/rsvp/${token}`).send({ rsvp: 'DECLINED' }).expect(204)
    })

    it('si falla una escritura, no se confirma NADA y el token sigue sirviendo', async () => {
      // Invitación, invitado y notificaciones en UNA transacción de Postgres:
      // si las notificaciones fallan, la invitación no puede quedar RESPONDED
      // con el invitado aún PENDING (la pareja lo vería como contestado).
      const { token, guestId, invitationId } = await invitacion()
      notificaciones.fallarProximaCreacion(new Error('fallo al crear notificaciones'))

      const fallo = await request(url).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' })

      expect(fallo.status).toBe(500)
      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'PENDING',
      )
      const fila = await prisma.guestInvitation.findUniqueOrThrow({ where: { id: invitationId } })
      expect(fila.status).toBe('DELIVERED')
      expect(fila.respondedAt).toBeNull()

      await request(url).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(204)
    })

    it('si encolar el aviso falla, la respuesta ya está persistida y el invitado ve 204', async () => {
      const { token, guestId, invitationId } = await invitacion()
      const espia = espiarCola().mockRejectedValueOnce(new Error('redis caído'))

      await request(url).post(`/rsvp/${token}`).send({ rsvp: 'DECLINED' }).expect(204)
      espia.mockRestore()

      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'DECLINED',
      )
      const fila = await prisma.guestInvitation.findUniqueOrThrow({ where: { id: invitationId } })
      expect(fila.status).toBe('RESPONDED')
      expect(await jobsDeAviso(invitationId)).toEqual([])
    })

    it('dos respuestas simultáneas con el mismo token: las dos se escriben', async () => {
      // Con el RSVP modificable (bloque A §2) ninguna de las dos es un error:
      // cada una es una respuesta válida y la que confirma después queda.
      const { token, guestId } = await invitacion()
      const creadasAntes = notificaciones.creadas.length
      const intentos = ['CONFIRMED', 'DECLINED'] as const

      const respuestas = await Promise.all(
        intentos.map((rsvp) => request(url).post(`/rsvp/${token}`).send({ rsvp })),
      )

      expect(respuestas.map((r) => r.status)).toEqual([204, 204])
      const invitado = await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })
      expect(intentos).toContain(invitado.rsvp)
      // Un juego de notificaciones por respuesta.
      expect(notificaciones.creadas.length - creadasAntes).toBe(4)
    })
  })

  describe('reinvitar o cambiar el email mata los tokens viejos (ruling C24)', () => {
    /**
     * Envía una invitación por el camino REAL (caso de uso → Postgres → BullMQ)
     * y devuelve el token en claro que viaja en el payload del job: la única
     * copia que existe, la misma que el worker mete en el correo.
     */
    async function enviarA(guestId: string): Promise<string> {
      const espia = espiarCola()
      try {
        await app.get(SendSingleInvitationUseCase).ejecutar(eventId, guestId)
        const payload = espia.mock.calls.at(-1)?.[2] as { token: string }
        tokensUsados.add(payload.token)
        return payload.token
      } finally {
        espia.mockRestore()
      }
    }

    async function invitadoPendiente(): Promise<string> {
      const { hash } = generarTokenInvitacion()
      return (
        await prisma.guest.create({
          data: {
            eventId,
            name: 'Ana Invitada',
            email: `c24-${hash.slice(0, 8)}@test.com`,
            group: 'Family',
          },
        })
      ).id
    }

    it('un segundo envío caduca el primer token: GET y POST con el viejo son 404', async () => {
      const guestId = await invitadoPendiente()
      const viejo = await enviarA(guestId)
      await request(url).get(`/rsvp/${viejo}`).expect(200)

      const nuevo = await enviarA(guestId)

      await request(url).get(`/rsvp/${viejo}`).expect(404)
      await request(url).post(`/rsvp/${viejo}`).send({ rsvp: 'DECLINED' }).expect(404)
      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'PENDING',
      )
      await request(url).post(`/rsvp/${nuevo}`).send({ rsvp: 'CONFIRMED' }).expect(204)
    })

    it('reenviar a quien YA respondió caduca también su token: GET y POST con el viejo son 404', async () => {
      // Con el RSVP modificable el token respondido aún escribe; si el reenvío
      // no lo matara, el enlace de un email mal tecleado seguiría pudiendo
      // cambiar el RSVP del invitado real.
      const guestId = await invitadoPendiente()
      const viejo = await enviarA(guestId)
      await request(url).post(`/rsvp/${viejo}`).send({ rsvp: 'CONFIRMED' }).expect(204)

      await enviarA(guestId)

      await request(url).get(`/rsvp/${viejo}`).expect(404)
      await request(url).post(`/rsvp/${viejo}`).send({ rsvp: 'DECLINED' }).expect(404)
      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'CONFIRMED',
      )
    })

    it('corregir un email mal tecleado caduca el enlace que recibió la dirección equivocada', async () => {
      const guestId = await invitadoPendiente()
      const delDesconocido = await enviarA(guestId)

      await app.get(UpdateGuestUseCase).ejecutar(eventId, guestId, {
        email: `corregido-${guestId}@test.com`,
      })

      await request(url).get(`/rsvp/${delDesconocido}`).expect(404)
      await request(url).post(`/rsvp/${delDesconocido}`).send({ rsvp: 'DECLINED' }).expect(404)
      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'PENDING',
      )
    })
  })

  describe('todo fallo de token es indistinguible', () => {
    /**
     * Inexistente, mal formado, caducado, caducado por el worker (C18) y
     * caducado por un reenvío (C24): MISMO status, MISMO code, MISMO mensaje,
     * en las dos rutas. Un token ya usado ya no está aquí: sigue sirviendo
     * (bloque A §2).
     */
    async function tokensQueFallan(): Promise<Array<[string, string]>> {
      const caducado = await invitacion({ expiresAt: new Date(Date.now() - 1000) })
      const caducadoPorElWorker = await invitacion()
      await prisma.guestInvitation.update({
        where: { id: caducadoPorElWorker.invitationId },
        data: { expiresAt: new Date() },
      })
      const respondidoYReenviado = await invitacion({ status: 'RESPONDED' })
      await prisma.guestInvitation.update({
        where: { id: respondidoYReenviado.invitationId },
        data: { expiresAt: new Date() },
      })

      return [
        ['inexistente', tokenInventado()],
        ['mal formado', 'no-es-un-token'],
        ['caducado', caducado.token],
        ['caducado por el worker (C18)', caducadoPorElWorker.token],
        ['respondido y caducado por un reenvío (C24)', respondidoYReenviado.token],
      ]
    }

    it('GET: el mismo 404 para todos', async () => {
      const casos = await tokensQueFallan()

      const cuerpos = []
      for (const [, token] of casos) {
        const respuesta = await request(url).get(`/rsvp/${token}`)
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
        const respuesta = await request(url).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' })
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
        await request(url).post(`/rsvp/${tokenInventado()}`).send({ rsvp: 'CONFIRMED' }).expect(404)
      }

      await request(url).post(`/rsvp/${tokenInventado()}`).send({ rsvp: 'CONFIRMED' }).expect(429)
    })

    it('el límite corta también un token VÁLIDO: se aplica antes de mirar el token', async () => {
      const { token } = await invitacion()
      for (let i = 0; i < 5; i += 1) {
        await request(url).post(`/rsvp/${tokenInventado()}`).send({ rsvp: 'CONFIRMED' })
      }

      await request(url).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(429)
    })

    it('GET: 20 por minuto; el 21 es un 429', async () => {
      for (let i = 0; i < 20; i += 1) {
        await request(url).get(`/rsvp/${tokenInventado()}`).expect(404)
      }

      await request(url).get(`/rsvp/${tokenInventado()}`).expect(429)
    })

    it('el contador vive en Redis: dos instancias comparten el mismo límite', async () => {
      // Con el almacén en memoria por defecto de `@nestjs/throttler`, cada
      // instancia contaría sus 5 y el límite real sería 5 × instancias.
      const { app: otra, url: otraUrl } = await crearApp()
      otrasApps.push(otra)

      for (let i = 0; i < 3; i += 1) {
        await request(url).post(`/rsvp/${tokenInventado()}`).send({ rsvp: 'CONFIRMED' }).expect(404)
      }
      for (let i = 0; i < 2; i += 1) {
        await request(otraUrl)
          .post(`/rsvp/${tokenInventado()}`)
          .send({ rsvp: 'CONFIRMED' })
          .expect(404)
      }

      await request(otraUrl)
        .post(`/rsvp/${tokenInventado()}`)
        .send({ rsvp: 'CONFIRMED' })
        .expect(429)
    })

    it('el RSVP lleva su límite Y el global; el de login no cae sobre él (C22)', async () => {
      const lectura = await request(url).get(`/rsvp/${tokenInventado()}`).expect(404)
      expect(lectura.headers['x-ratelimit-limit-rsvp']).toBe('20')
      expect(lectura.headers['x-ratelimit-limit-global']).toBe('120')
      expect(lectura.headers['x-ratelimit-limit-login']).toBeUndefined()

      const respuesta = await request(url)
        .post(`/rsvp/${tokenInventado()}`)
        .send({ rsvp: 'CONFIRMED' })
        .expect(404)
      expect(respuesta.headers['x-ratelimit-limit-rsvp']).toBe('5')
      expect(respuesta.headers['x-ratelimit-limit-global']).toBe('120')
    })

    it('las demás rutas sin sesión llevan el global, y no el límite del RSVP (C22)', async () => {
      // `register` enumera cuentas vía 409 y `refresh` acepta un secreto: sin
      // límite propio, el global es su único suelo.
      const registro = await request(url)
        .post('/auth/register')
        .send({ email: 'alguien@test.com', password: 'una-contraseña-larga', fullName: 'Alguien' })
        .expect(201)
      expect(registro.headers['x-ratelimit-limit-global']).toBe('120')
      expect(registro.headers['x-ratelimit-limit-rsvp']).toBeUndefined()
      expect(registro.headers['x-ratelimit-limit-login']).toBeUndefined()

      const refresco = await request(url).post('/auth/refresh').expect(401)
      expect(refresco.headers['x-ratelimit-limit-global']).toBe('120')
      expect(refresco.headers['x-ratelimit-limit-rsvp']).toBeUndefined()
    })
  })

  describe('el token nunca llega al log', () => {
    it('ni en un 404, ni en un 400, ni en un 500, ni en el aviso de la cola, ni en un 429', async () => {
      const valido = await invitacion()
      const otro = await invitacion()
      registro.lineas.length = 0

      await request(url).get(`/rsvp/${tokenInventado()}`).expect(404)
      await request(url).post(`/rsvp/${valido.token}`).send({ rsvp: 'MAYBE' }).expect(400)
      notificaciones.fallarProximaCreacion(new Error('fallo al crear notificaciones'))
      await request(url).post(`/rsvp/${valido.token}`).send({ rsvp: 'CONFIRMED' }).expect(500)
      const espia = espiarCola().mockRejectedValueOnce(new Error('redis caído'))
      await request(url).post(`/rsvp/${otro.token}`).send({ rsvp: 'CONFIRMED' }).expect(204)
      espia.mockRestore()
      for (let i = 0; i < 3; i += 1) {
        await request(url).post(`/rsvp/${tokenInventado()}`).send({ rsvp: 'CONFIRMED' })
      }
      const cortado = await request(url)
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
