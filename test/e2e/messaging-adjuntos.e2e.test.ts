import type { Server } from 'node:http'

import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { io, type Socket as SocketCliente } from 'socket.io-client'
import request from 'supertest'

import { AppModule } from '@/app.module'
import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { configurarApp, OPCIONES_DE_FABRICA } from '@/configurar-app'
import { TokenService } from '@/modules/auth/application/token.service'
import { OBJECT_STORAGE } from '@/modules/storage/application/object-storage.port'
import { ObjectStorageEnMemoria } from '@/modules/storage/infrastructure/object-storage.fake'

import { fijarEntorno } from '../support/app'
import { categoriaId } from '../support/categorias'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { limpiarContadoresDeRitmo } from '../support/throttler'

interface AdjuntoCuerpo {
  name: string
  contentType: string
  bytes: number
}

interface MensajeCuerpo {
  id: string
  conversationId: string
  senderId: string
  body: string
  attachment: AdjuntoCuerpo | null
}

interface ErrorCuerpo {
  code: string
}

interface FacturaDeMensajeCuerpo {
  key: string
  name: string
  suggestedEventVendorId: string | null
}

type Actor =
  'creador' | 'pareja' | 'planner' | 'provP' | 'provQ' | 'provZ' | 'tarde' | 'revocado' | 'extrano'

/**
 * Adjuntos en el chat y factura desde el chat (spec 2026-11-12) a través de la
 * app real. Como en `moodboard.e2e`, la app se construye igual que `main.ts`
 * salvo UN provider: `OBJECT_STORAGE` pasa a `ObjectStorageEnMemoria`, porque
 * sin R2 en el entorno de test `attachment-upload-url` sería siempre 503.
 * Alternativa descartada: sembrar los mensajes con Prisma, que dejaría sin
 * probar el recorrido preparar → subir → enviar → descargar.
 *
 * Las membresías (alta, revocación) se escriben con Prisma igual que en
 * `messaging-sala.e2e`: no son la tabla bajo prueba.
 */
describe('adjuntos de mensajería e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let app: NestExpressApplication
  let server: Server
  let url: string
  let prisma: PrismaClient
  const almacen = new ObjectStorageEnMemoria()
  const abiertos: SocketCliente[] = []

  let eventoId: string
  let eventoAjenoId: string
  let contratacionP: string
  let contratacionZ: string
  const tokens = new Map<Actor, string>()
  let id: Record<Actor, string>

  function tokenDe(actor: Actor): string {
    const token = tokens.get(actor)
    if (!token) throw new Error(`sin token para ${actor}`)
    return token
  }
  const como = (actor: Actor) => ({ Authorization: `Bearer ${tokenDe(actor)}` })

  /** Abre (o recupera) el 1:1 de `desde` con `con` en el evento. */
  async function abrirUnoAUno(desde: Actor, con: Actor, evento = eventoId): Promise<string> {
    const r = await request(server)
      .post(`/events/${evento}/conversations`)
      .set(como(desde))
      .send({ userId: id[con] })
    expect([200, 201]).toContain(r.status)
    return (r.body as { id: string }).id
  }

  async function abrirSala(como_: Actor): Promise<string> {
    const r = await request(server).get(`/events/${eventoId}/room`).set(como(como_)).expect(200)
    return (r.body as { id: string }).id
  }

  /** `attachment-upload-url` + subida simulada al almacén falso: devuelve la key. */
  async function keySubida(conversationId: string, quien: Actor): Promise<string> {
    const r = await request(server)
      .post(`/conversations/${conversationId}/attachment-upload-url`)
      .set(como(quien))
      .send({ contentType: 'application/pdf', bytes: 2048 })
      .expect(201)
    const { key } = r.body as { key: string }
    almacen.simularSubida(key, 'application/pdf', 2048)
    return key
  }

  /** Envía un PDF (sin texto por defecto) y devuelve el mensaje. */
  async function enviarPdf(
    conversationId: string,
    quien: Actor,
    name = 'factura-flores.pdf',
    body?: string,
  ): Promise<MensajeCuerpo> {
    const key = await keySubida(conversationId, quien)
    const r = await request(server)
      .post(`/conversations/${conversationId}/messages`)
      .set(como(quien))
      .send({ ...(body === undefined ? {} : { body }), attachment: { key, name } })
      .expect(201)
    return r.body as MensajeCuerpo
  }

  function descargar(conversationId: string, mensajeId: string, quien: Actor): request.Test {
    return request(server)
      .get(`/conversations/${conversationId}/messages/${mensajeId}/attachment`)
      .set(como(quien))
  }

  function facturaDeMensaje(quien: Actor, messageId: string, evento = eventoId): request.Test {
    return request(server)
      .post(`/events/${evento}/expenses/invoice-from-message`)
      .set(como(quien))
      .send({ messageId })
  }

  async function membresia(actor: Actor, status: 'ACTIVE' | 'REVOKED'): Promise<void> {
    await prisma.eventMembership.upsert({
      where: { eventId_userId: { eventId: eventoId, userId: id[actor] } },
      create: { eventId: eventoId, userId: id[actor], role: 'PLANNER', status },
      update: { status },
    })
  }

  async function conectarComo(actor: Actor, unirse = false): Promise<SocketCliente> {
    const socket = io(`${url}/realtime`, {
      auth: { token: tokenDe(actor) },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    })
    abiertos.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('connect_error', reject)
    })
    if (unirse) {
      const unido = (await socket
        .timeout(5_000)
        .emitWithAck('join', { eventId: eventoId })) as unknown
      expect(unido).toEqual({ ok: true })
    }
    return socket
  }

  function esperar(socket: SocketCliente, evento: string, ms = 10_000): Promise<unknown> {
    const espera = new Promise<unknown>((resolve, reject) => {
      const reloj = setTimeout(() => reject(new Error(`no llegó ${evento} en ${ms} ms`)), ms)
      socket.once(evento, (datos: unknown) => {
        clearTimeout(reloj)
        resolve(datos)
      })
    })
    espera.catch(() => undefined)
    return espera
  }

  /** Todo lo que recibe un socket salvo `presence.changed`, no determinista. */
  function grabar(socket: SocketCliente): string[] {
    const recibidos: string[] = []
    socket.onAny((evento: string) => {
      if (evento !== 'presence.changed') recibidos.push(evento)
    })
    return recibidos
  }

  const pausa = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })

    const modulo = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OBJECT_STORAGE)
      .useValue(almacen)
      .compile()
    app = modulo.createNestApplication<NestExpressApplication>({
      ...OPCIONES_DE_FABRICA,
      logger: false,
    })
    await configurarApp(app, app.get<Env>(ENV))
    await app.init()
    await app.listen(0, '127.0.0.1')
    url = (await app.getUrl()).replace('[::1]', '127.0.0.1')
    server = app.getHttpServer()

    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const firmador = app.get(TokenService)
    const actores: Actor[] = [
      'creador',
      'pareja',
      'planner',
      'provP',
      'provQ',
      'provZ',
      'tarde',
      'revocado',
      'extrano',
    ]
    const creados = await Promise.all(
      actores.map(async (actor) => {
        const u = await prisma.user.create({
          data: { email: `${actor}@adjuntos.test`, passwordHash: 'x', fullName: actor },
        })
        return [actor, u.id, firmador.firmarAccess({ id: u.id, systemRole: u.systemRole })] as const
      }),
    )
    id = Object.fromEntries(creados.map(([actor, uid]) => [actor, uid])) as Record<Actor, string>
    for (const [actor, , token] of creados) tokens.set(actor, token)

    const weddingDate = new Date(Date.now() + 180 * 86_400_000)
    eventoId = (
      await prisma.event.create({
        data: { name: 'Boda adjuntos', weddingDate, ownerId: id.creador, status: 'ACTIVE' },
      })
    ).id
    eventoAjenoId = (
      await prisma.event.create({
        data: { name: 'Evento ajeno', weddingDate, ownerId: id.extrano, status: 'ACTIVE' },
      })
    ).id
    await prisma.eventMembership.createMany({
      data: [
        { eventId: eventoId, userId: id.creador, role: 'PLANNER' },
        { eventId: eventoId, userId: id.pareja, role: 'COUPLE' },
        { eventId: eventoId, userId: id.planner, role: 'PLANNER' },
        { eventId: eventoAjenoId, userId: id.extrano, role: 'COUPLE' },
      ],
    })

    const categoryId = await categoriaId(prisma, 'photography')
    const contratar = async (userId: string, nombre: string, evento: string) => {
      const perfil = await prisma.vendorProfile.create({
        data: { userId, businessName: nombre, categoryId, status: 'PUBLISHED' },
      })
      return (
        await prisma.eventVendor.create({
          data: { eventId: evento, vendorProfileId: perfil.id, categoryId, status: 'BOOKED' },
        })
      ).id
    }
    contratacionP = await contratar(id.provP, 'Proveedor P', eventoId)
    await contratar(id.provQ, 'Proveedor Q', eventoId)
    contratacionZ = await contratar(id.provZ, 'Proveedor Z', eventoAjenoId)
  }, 240_000)

  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
    await prisma.expense.deleteMany()
    await prisma.notification.deleteMany()
    await prisma.message.deleteMany()
    await prisma.conversation.deleteMany()
    await prisma.eventMembership.deleteMany({
      where: { eventId: eventoId, userId: { in: [id.tarde, id.revocado] } },
    })
    almacen.borradas.length = 0
  })

  afterEach(() => {
    for (const socket of abiertos.splice(0)) socket.disconnect()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
    await redis.stop()
    await pg.stop()
  })

  describe('1:1 con un proveedor', () => {
    it('P envía un PDF sin texto: el creador lo ve en el listado y lo descarga', async () => {
      const conv = await abrirUnoAUno('creador', 'provP')
      const m = await enviarPdf(conv, 'provP')
      expect(m.body).toBe('')
      expect(m.attachment).toEqual({
        name: 'factura-flores.pdf',
        contentType: 'application/pdf',
        bytes: 2048,
      })
      expect(JSON.stringify(m)).not.toContain('events/')

      const lista = await request(server)
        .get(`/conversations/${conv}/messages`)
        .set(como('creador'))
        .expect(200)
      const visto = (lista.body as { items: MensajeCuerpo[] }).items.find((x) => x.id === m.id)
      expect(visto?.attachment).toEqual(m.attachment)
      expect(JSON.stringify(visto)).not.toContain('events/')

      const r = await descargar(conv, m.id, 'creador').expect(200)
      expect(typeof (r.body as { url: string }).url).toBe('string')
    })

    it('el socket del creador recibe message.created con el adjunto y sin key ni url', async () => {
      const conv = await abrirUnoAUno('creador', 'provP')
      const socket = await conectarComo('creador')
      const llega = esperar(socket, 'message.created')
      const m = await enviarPdf(conv, 'provP')
      const evento = (await llega) as { conversationId: string; message: Record<string, unknown> }
      expect(evento.conversationId).toBe(conv)
      expect(evento.message.id).toBe(m.id)
      expect(evento.message.attachment).toEqual({
        name: 'factura-flores.pdf',
        contentType: 'application/pdf',
        bytes: 2048,
      })
      const texto = JSON.stringify(evento)
      expect(texto).not.toContain('events/')
      expect(texto).not.toContain('"key"')
      expect(texto).not.toContain('"url"')
      expect(texto).not.toContain('https://')
    })

    it('Q y un extraño piden el adjunto del 1:1 de P: 404', async () => {
      const conv = await abrirUnoAUno('creador', 'provP')
      const m = await enviarPdf(conv, 'provP')
      await descargar(conv, m.id, 'provQ').expect(404)
      await descargar(conv, m.id, 'extrano').expect(404)
    })
  })

  describe('sala del evento', () => {
    it('la pareja envía con adjunto: el planner y quien entra después lo descargan', async () => {
      const salaId = await abrirSala('pareja')
      const m = await enviarPdf(salaId, 'pareja', 'menu.pdf', 'el menú')
      expect(m.body).toBe('el menú')
      await membresia('tarde', 'ACTIVE')

      await descargar(salaId, m.id, 'planner').expect(200)
      await descargar(salaId, m.id, 'tarde').expect(200)
    })

    it('quien salió de la sala descarga el adjunto anterior a su salida y no el posterior (visibleHasta)', async () => {
      // `revocado` es participante de verdad: abre la sala y marca leído antes de salir.
      await membresia('revocado', 'ACTIVE')
      const salaId = await abrirSala('revocado')
      const inicial = await enviarPdf(salaId, 'pareja', 'inicial.pdf', 'bienvenidos')
      await request(server)
        .post(`/conversations/${salaId}/read`)
        .set(como('revocado'))
        .send({ upTo: inicial.id })
        .expect(204)
      const antes = await enviarPdf(salaId, 'pareja', 'antes.pdf')

      await membresia('revocado', 'REVOKED')
      const despues = await enviarPdf(salaId, 'pareja', 'despues.pdf')

      await descargar(salaId, antes.id, 'revocado').expect(200)
      await descargar(salaId, despues.id, 'revocado').expect(404)
      await descargar(salaId, despues.id, 'planner').expect(200)
    })
  })

  describe('PROFILE y validaciones', () => {
    it('en una conversación PROFILE no se pueden preparar ni enviar adjuntos', async () => {
      const categoryId = await categoriaId(prisma, 'photography')
      const ficha = await prisma.vendorProfile.findFirstOrThrow({ where: { userId: id.provP } })
      expect(ficha.categoryId).toBe(categoryId)
      const r = await request(server)
        .post(`/vendors/${ficha.id}/contact`)
        .set(como('pareja'))
        .send({
          body: 'Hola, somos una pareja y queremos saber si tenéis fecha libre para nuestra boda.',
        })
      expect(r.status).toBe(201)
      const perfilId = (r.body as { conversation: { id: string } }).conversation.id

      const prep = await request(server)
        .post(`/conversations/${perfilId}/attachment-upload-url`)
        .set(como('pareja'))
        .send({ contentType: 'application/pdf', bytes: 2048 })
        .expect(422)
      expect((prep.body as ErrorCuerpo).code).toBe('ATTACHMENTS_NOT_ALLOWED')

      const env = await request(server)
        .post(`/conversations/${perfilId}/messages`)
        .set(como('pareja'))
        .send({
          attachment: { key: `events/${eventoId}/messages/${perfilId}/x.pdf`, name: 'a.pdf' },
        })
        .expect(422)
      expect((env.body as ErrorCuerpo).code).toBe('ATTACHMENTS_NOT_ALLOWED')
    })

    it('un tipo no permitido es 422 INVALID_ATTACHMENT', async () => {
      const conv = await abrirUnoAUno('creador', 'provP')
      const r = await request(server)
        .post(`/conversations/${conv}/attachment-upload-url`)
        .set(como('creador'))
        .send({ contentType: 'image/gif', bytes: 2048 })
        .expect(422)
      expect((r.body as ErrorCuerpo).code).toBe('INVALID_ATTACHMENT')
    })

    it('un nombre de 201 caracteres es 422 INVALID_ATTACHMENT_NAME', async () => {
      const conv = await abrirUnoAUno('creador', 'provP')
      const key = await keySubida(conv, 'creador')
      const r = await request(server)
        .post(`/conversations/${conv}/messages`)
        .set(como('creador'))
        .send({ attachment: { key, name: `${'a'.repeat(197)}.pdf` } })
        .expect(422)
      expect((r.body as ErrorCuerpo).code).toBe('INVALID_ATTACHMENT_NAME')
    })

    it('un nombre con barra es 422 INVALID_ATTACHMENT_NAME', async () => {
      const conv = await abrirUnoAUno('creador', 'provP')
      const key = await keySubida(conv, 'creador')
      const r = await request(server)
        .post(`/conversations/${conv}/messages`)
        .set(como('creador'))
        .send({ attachment: { key, name: 'a/b.pdf' } })
        .expect(422)
      expect((r.body as ErrorCuerpo).code).toBe('INVALID_ATTACHMENT_NAME')
    })
  })

  describe('factura desde el chat', () => {
    it('el creador convierte el adjunto de P en factura de un gasto PENDING que P no ve', async () => {
      const conv = await abrirUnoAUno('creador', 'provP')
      const socketP = await conectarComo('provP', true)
      // El eco del propio envío de P llega por el worker: se espera antes de grabar,
      // para que lo grabado sea sólo lo que provoque la conversión y el gasto.
      const eco = esperar(socketP, 'message.created')
      const m = await enviarPdf(conv, 'provP')
      await eco
      const recibidosP = grabar(socketP)

      const r = await facturaDeMensaje('creador', m.id).expect(201)
      const factura = r.body as FacturaDeMensajeCuerpo
      expect(factura.key.startsWith(`events/${eventoId}/invoices/`)).toBe(true)
      expect(factura.suggestedEventVendorId).toBe(contratacionP)

      const gasto = await request(server)
        .post(`/events/${eventoId}/expenses`)
        .set(como('creador'))
        .send({
          concept: 'Flores',
          category: 'Decor',
          amount: '100.00',
          eventVendorId: contratacionP,
          invoiceFile: { key: factura.key, name: factura.name },
        })
        .expect(201)
      const gastoId = (gasto.body as { id: string; status: string }).id
      expect((gasto.body as { status: string }).status).toBe('PENDING')

      await pausa(2_000)
      expect(recibidosP).toEqual([])
      const pagos = await request(server).get('/me/vendor-payments').set(como('provP')).expect(200)
      expect(JSON.stringify(pagos.body)).not.toContain(gastoId)
    })

    it('asociarla a un gasto existente borra el archivo anterior y el adjunto sigue descargable', async () => {
      const conv = await abrirUnoAUno('creador', 'provP')
      const m1 = await enviarPdf(conv, 'provP', 'primera.pdf')
      const f1 = (await facturaDeMensaje('creador', m1.id).expect(201))
        .body as FacturaDeMensajeCuerpo
      const gasto = await request(server)
        .post(`/events/${eventoId}/expenses`)
        .set(como('creador'))
        .send({
          concept: 'Flores',
          category: 'Decor',
          amount: '100.00',
          eventVendorId: contratacionP,
          invoiceFile: { key: f1.key, name: f1.name },
        })
        .expect(201)
      const gastoId = (gasto.body as { id: string }).id

      const m2 = await enviarPdf(conv, 'provP', 'segunda.pdf')
      const f2 = (await facturaDeMensaje('creador', m2.id).expect(201))
        .body as FacturaDeMensajeCuerpo
      await request(server)
        .patch(`/events/${eventoId}/expenses/${gastoId}`)
        .set(como('creador'))
        .send({ invoiceFile: { key: f2.key, name: f2.name } })
        .expect(200)

      expect(almacen.borradas).toContain(f1.key)
      expect(almacen.borradas).not.toContain(f2.key)
      await descargar(conv, m1.id, 'creador').expect(200)
      await descargar(conv, m2.id, 'creador').expect(200)
    })

    it('matriz de acceso de invoice-from-message', async () => {
      const conv = await abrirUnoAUno('creador', 'provP')
      const m = await enviarPdf(conv, 'provP')
      for (const quien of ['pareja', 'planner', 'provP', 'provQ'] as const) {
        await facturaDeMensaje(quien, m.id).expect(403)
      }
      await facturaDeMensaje('extrano', m.id).expect(404)

      const convAjena = await abrirUnoAUno('extrano', 'provZ', eventoAjenoId)
      expect(contratacionZ).toBeTruthy()
      const ajeno = await enviarPdf(convAjena, 'provZ')
      const r = await facturaDeMensaje('creador', ajeno.id).expect(404)
      expect((r.body as ErrorCuerpo).code).toBe('MESSAGE_NOT_FOUND')
    })
  })
})
