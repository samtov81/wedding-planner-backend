import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'

import { type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { Webhook } from 'svix'

import { AppModule } from '@/app.module'
import { DomainExceptionFilter } from '@/shared/http/domain-exception.filter'

import { startPostgres, type PostgresDeTest } from '../support/containers'

type EstadoInvitacion = 'QUEUED' | 'SENT' | 'DELIVERED' | 'BOUNCED' | 'COMPLAINED' | 'RESPONDED'

const SECRETO = `whsec_${Buffer.from('secreto-e2e-del-webhook-32-bytes').toString('base64')}`

describe('Webhook de Resend e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let app: INestApplication
  let server: Server
  let prisma: PrismaClient
  let guestId: string

  /** Una invitación ya enviada (SENT) con su id del proveedor, como la deja el worker. */
  async function invitacionEnviada(
    status: EstadoInvitacion = 'SENT',
  ): Promise<{ id: string; mensaje: string }> {
    const mensaje = `re_${randomUUID()}`
    const fila = await prisma.guestInvitation.create({
      data: {
        guestId,
        tokenHash: randomUUID(),
        status,
        resendMessageId: mensaje,
        sentAt: new Date(),
        expiresAt: new Date(Date.UTC(2027, 0, 1)),
      },
    })
    return { id: fila.id, mensaje }
  }

  async function estadoDe(id: string): Promise<string | undefined> {
    return (await prisma.guestInvitation.findUnique({ where: { id } }))?.status
  }

  /**
   * El cuerpo se construye como TEXTO, con espacios y un orden de claves que
   * `JSON.stringify(JSON.parse(...))` no reproduce: si el servidor verificara
   * sobre `req.body` re-serializado en vez de los bytes crudos, estas firmas
   * no casarían y los tests de entrega darían 401.
   */
  function cuerpoDe(type: string, emailId?: string): string {
    const data =
      emailId === undefined ? '{ }' : `{ "email_id": "${emailId}",  "to": ["x@test.com"] }`
    return `{ "created_at": "2026-09-18T10:00:00.000Z",  "type": "${type}", "data": ${data} }`
  }

  function firmar(cuerpo: string, cuando = new Date()): Record<string, string> {
    const id = `msg_${randomUUID()}`
    return {
      'svix-id': id,
      'svix-timestamp': String(Math.floor(cuando.getTime() / 1000)),
      'svix-signature': new Webhook(SECRETO).sign(id, cuando, cuerpo),
    }
  }

  function enviar(cuerpo: string, cabeceras: Record<string, string>): request.Test {
    return request(server)
      .post('/webhooks/resend')
      .set('Content-Type', 'application/json')
      .set(cabeceras)
      .send(cuerpo)
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
    process.env.RESEND_WEBHOOK_SECRET = SECRETO

    // Igual que `main.ts`: sin `rawBody: true` no hay bytes que verificar.
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true })
    app.use(cookieParser())
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
    server = app.getHttpServer() as Server
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    const usuario = await prisma.user.create({
      data: { email: 'pareja@test.com', passwordHash: 'x', fullName: 'Pareja' },
    })
    const evento = await prisma.event.create({
      data: {
        name: 'Boda del webhook',
        weddingDate: new Date(Date.UTC(2027, 5, 12)),
        ownerId: usuario.id,
      },
    })
    const invitado = await prisma.guest.create({
      data: { eventId: evento.id, name: 'Invitada', email: 'invitada@test.com', group: 'Family' },
    })
    guestId = invitado.id
  }, 240_000)

  afterAll(async () => {
    delete process.env.RESEND_WEBHOOK_SECRET
    await prisma.$disconnect()
    await app.close()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('rechaza un webhook con firma inválida sin tocar la base de datos', async () => {
    const { id, mensaje } = await invitacionEnviada()

    const respuesta = await request(server)
      .post('/webhooks/resend')
      .set('svix-id', 'msg_falso')
      .set('svix-timestamp', String(Math.floor(Date.now() / 1000)))
      .set('svix-signature', 'v1,firmainventada')
      .send({ type: 'email.bounced', data: { email_id: mensaje } })
      .expect(401)

    expect((respuesta.body as { code: string }).code).toBe('INVALID_SIGNATURE')
    // Lo que de verdad importa: el estado NO cambió.
    expect(await estadoDe(id)).toBe('SENT')
  })

  it('rechaza sin cabeceras de firma: la ruta es pública, pero no anónima', async () => {
    const { id, mensaje } = await invitacionEnviada()

    await enviar(cuerpoDe('email.bounced', mensaje), {}).expect(401)

    expect(await estadoDe(id)).toBe('SENT')
  })

  it('rechaza una firma válida pero caducada (reenvío de una petición capturada)', async () => {
    const { id, mensaje } = await invitacionEnviada()
    const cuerpo = cuerpoDe('email.bounced', mensaje)

    await enviar(cuerpo, firmar(cuerpo, new Date(Date.now() - 10 * 60_000))).expect(401)

    expect(await estadoDe(id)).toBe('SENT')
  })

  it('rechaza un cuerpo cambiado tras firmar', async () => {
    const { id, mensaje } = await invitacionEnviada()
    const cabeceras = firmar(cuerpoDe('email.delivered', mensaje))

    await enviar(cuerpoDe('email.bounced', mensaje), cabeceras).expect(401)

    expect(await estadoDe(id)).toBe('SENT')
  })

  it('un evento bien firmado actualiza el estado, sin JWT de por medio', async () => {
    const { id, mensaje } = await invitacionEnviada()
    const cuerpo = cuerpoDe('email.delivered', mensaje)

    await enviar(cuerpo, firmar(cuerpo)).expect(204)

    expect(await estadoDe(id)).toBe('DELIVERED')
  })

  it('la reentrega del MISMO evento responde 2xx y deja el mismo estado', async () => {
    const { id, mensaje } = await invitacionEnviada()
    const cuerpo = cuerpoDe('email.bounced', mensaje)
    const cabeceras = firmar(cuerpo)

    await enviar(cuerpo, cabeceras).expect(204)
    await enviar(cuerpo, cabeceras).expect(204)

    expect(await estadoDe(id)).toBe('BOUNCED')
  })

  it('un delivered tardío no pisa un BOUNCED (monotonía en la escritura de Postgres)', async () => {
    const { id, mensaje } = await invitacionEnviada()
    const rebote = cuerpoDe('email.bounced', mensaje)
    const entrega = cuerpoDe('email.delivered', mensaje)

    await enviar(rebote, firmar(rebote)).expect(204)
    await enviar(entrega, firmar(entrega)).expect(204)

    expect(await estadoDe(id)).toBe('BOUNCED')
  })

  it('nada del proveedor pisa un RESPONDED', async () => {
    const { id, mensaje } = await invitacionEnviada('RESPONDED')

    for (const tipo of ['email.delivered', 'email.bounced', 'email.complained']) {
      const cuerpo = cuerpoDe(tipo, mensaje)
      await enviar(cuerpo, firmar(cuerpo)).expect(204)
    }

    expect(await estadoDe(id)).toBe('RESPONDED')
  })

  it('webhooks concurrentes del mismo correo: el estado final no retrocede', async () => {
    // Sin la guarda en el WHERE, el `delivered` que se escriba el último gana.
    // Este test NO puede forzar el entrelazado (el orden lo decide el
    // servidor): con la guarda es siempre verde, sin ella es rojo sólo a veces.
    // La prueba determinista es el test secuencial de arriba; éste vigila que
    // la concurrencia real no cambie el resultado.
    const { id, mensaje } = await invitacionEnviada()
    const rebote = cuerpoDe('email.bounced', mensaje)
    const entrega = cuerpoDe('email.delivered', mensaje)

    await Promise.all([
      enviar(rebote, firmar(rebote)).expect(204),
      enviar(entrega, firmar(entrega)).expect(204),
      enviar(entrega, firmar(entrega)).expect(204),
    ])

    expect(await estadoDe(id)).toBe('BOUNCED')
  })

  it('un messageId que no es de ninguna invitación responde 2xx para que Resend no reintente', async () => {
    const cuerpo = cuerpoDe('email.delivered', 're_de_otro_correo')

    await enviar(cuerpo, firmar(cuerpo)).expect(204)
  })

  it('un evento que no es de correo (sin email_id) se acepta y se ignora', async () => {
    const cuerpo = cuerpoDe('contact.created')

    await enviar(cuerpo, firmar(cuerpo)).expect(204)
  })

  it('un email.* firmado pero sin email_id es un cuerpo roto: 400', async () => {
    const cuerpo = cuerpoDe('email.delivered')

    await enviar(cuerpo, firmar(cuerpo)).expect(400)
  })

  it('las demás rutas siguen parseando JSON con normalidad', async () => {
    // `rawBody: true` no puede romper el `req.body` del resto de la API.
    const respuesta = await request(server)
      .post('/auth/register')
      .send({ email: 'otra@test.com', password: 'una-contraseña-larga', fullName: 'Otra' })
      .expect(201)

    expect((respuesta.body as { id?: string }).id).toBeDefined()
  })
})
