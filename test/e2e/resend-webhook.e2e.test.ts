import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'
import { Webhook } from 'svix'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { limpiarContadoresDeRitmo } from '../support/throttler'

type EstadoInvitacion = 'QUEUED' | 'SENT' | 'DELIVERED' | 'BOUNCED' | 'COMPLAINED' | 'RESPONDED'

const SECRETO = `whsec_${Buffer.from('secreto-e2e-del-webhook-32-bytes').toString('base64')}`

describe('Webhook de Resend e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
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
    return request(url)
      .post('/webhooks/resend')
      .set('Content-Type', 'application/json')
      .set(cabeceras)
      .send(cuerpo)
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno(
      { databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() },
      { RESEND_WEBHOOK_SECRET: SECRETO },
    )

    // El arranque de `main.ts` (`configurarApp`): el parser de cuerpo con su
    // límite es el que se despliega, y la firma tiene que seguir verificándose
    // sobre los bytes crudos que ese parser guarda.
    ;({ url, cerrar } = await arrancarAppDeTest())
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

  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
  })

  afterAll(async () => {
    delete process.env.RESEND_WEBHOOK_SECRET
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('rechaza un webhook con firma inválida sin tocar la base de datos', async () => {
    const { id, mensaje } = await invitacionEnviada()

    const respuesta = await request(url)
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

  it('el webhook no lleva el límite global sino el suyo propio', async () => {
    const respuesta = await request(url)
      .post('/webhooks/resend')
      .set('Content-Type', 'application/json')
      .send('{}')

    expect(respuesta.headers['x-ratelimit-limit-global']).toBeUndefined()
    expect(respuesta.headers['x-ratelimit-limit-webhook']).toBe('1200')
  })

  it('las demás rutas siguen parseando JSON con normalidad', async () => {
    // `rawBody: true` no puede romper el `req.body` del resto de la API.
    const respuesta = await request(url)
      .post('/auth/register')
      .send({ email: 'otra@test.com', password: 'una-contraseña-larga', fullName: 'Otra' })
      .expect(201)

    expect((respuesta.body as { id?: string }).id).toBeDefined()
  })

  describe('con el límite de cuerpo del arranque (Tarea 16)', () => {
    /** Un evento válido y firmado, inflado con un campo que el DTO ignora. */
    function cuerpoDeTamaño(bytes: number, mensaje: string): string {
      const relleno = 'x'.repeat(bytes)
      return `{ "type": "email.delivered", "created_at": "2026-09-18T10:00:00.000Z", "data": { "email_id": "${mensaje}", "relleno": "${relleno}" } }`
    }

    it('un webhook de 150 kB (por encima del límite por defecto de Express) se verifica y aplica', async () => {
      const { id, mensaje } = await invitacionEnviada()
      const cuerpo = cuerpoDeTamaño(150_000, mensaje)

      await enviar(cuerpo, firmar(cuerpo)).expect(204)

      expect(await estadoDe(id)).toBe('DELIVERED')
    })

    it('un webhook por encima de 256 kB es 413 antes de verificar nada', async () => {
      const { id, mensaje } = await invitacionEnviada()
      const cuerpo = cuerpoDeTamaño(300_000, mensaje)

      const respuesta = await enviar(cuerpo, firmar(cuerpo)).expect(413)

      expect((respuesta.body as { code?: string }).code).toBe('PAYLOAD_TOO_LARGE')
      expect(await estadoDe(id)).toBe('SENT')
    })
  })
})
