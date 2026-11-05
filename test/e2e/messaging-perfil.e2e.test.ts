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

type Quien = 'pareja' | 'prov' | 'draft' | 'otro'

interface ConversacionCuerpo {
  id: string
  kind: string
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED'
  direction: 'SENT' | 'RECEIVED'
  other: { userId: string; displayName: string }
  lastMessage: { body: string } | null
  retryAt: string | null
}

interface ErrorCuerpo {
  code: string
  details?: { conversationId?: string; retryAt?: string }
  requestId?: string
}

interface Recibido {
  evento: string
  datos: unknown
}

const ID_INEXISTENTE = '00000000-0000-4000-8000-000000000000'
const TEXTO_LARGO =
  `Hola, somos Ana y Luis y nos casamos el 14 de junio. ${'Nos encantaría saber si tenéis fecha. '.repeat(8)}`.trim()

/**
 * Contacto desde la ficha pública de un proveedor (mensajería parte 3), de
 * extremo a extremo: HTTP, Postgres y Redis reales y el worker de BullMQ
 * emitiendo por Socket.IO. Sin dobles: los de `*.paridad.test.ts` ya prueban
 * que el doble y Prisma coinciden; esto prueba lo que se despliega.
 */
describe('contacto desde la ficha e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let cerrar: () => Promise<void>
  let server: Server
  let url: string
  let prisma: PrismaClient
  const abiertos: SocketCliente[] = []
  let t: Record<Quien, string>
  let id: Record<Quien, string>
  let ficha: { pareja: string; prov: string; draft: string }

  const como = (token: string) => ({ Authorization: `Bearer ${token}` })

  const pedir = (token: string, fichaId: string, body = TEXTO_LARGO): request.Test =>
    request(server).post(`/vendors/${fichaId}/contact`).set(como(token)).send({ body })

  async function solicitud(token = t.pareja, fichaId = ficha.prov): Promise<string> {
    const r = await pedir(token, fichaId).expect(201)
    return (r.body as { conversation: { id: string } }).conversation.id
  }

  const responder = (token: string, convId: string, accion: 'accept' | 'decline'): request.Test =>
    request(server).post(`/conversations/${convId}/${accion}`).set(como(token))

  const escribir = (token: string, convId: string, body: string): request.Test =>
    request(server).post(`/conversations/${convId}/messages`).set(como(token)).send({ body })

  const estado = async (token: string, fichaId: string) =>
    (await request(server).get(`/vendors/${fichaId}/contact`).set(como(token)).expect(200))
      .body as { state: string; conversationId: string | null; retryAt: string | null }

  async function bandeja(token: string) {
    const r = await request(server).get('/me/profile-conversations').set(como(token)).expect(200)
    return r.body as { items: ConversacionCuerpo[]; requestsPending: number; unreadTotal: number }
  }

  async function mensajes(token: string, convId: string): Promise<string[]> {
    const r = await request(server).get(`/conversations/${convId}/messages`).set(como(token))
    expect(r.status).toBe(200)
    return (r.body as { items: Array<{ body: string }> }).items.map((m) => m.body)
  }

  /** Retrasa `declinedAt` exactamente 24 h: el instante en que ya se puede reintentar. */
  async function moverRechazoAtras24h(convId: string): Promise<void> {
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: convId } })
    expect(conv.requestStatus).toBe('DECLINED')
    const declinedAt = new Date((conv.declinedAt ?? new Date()).getTime() - 86_400_000)
    // `declinedAt` sigue no nulo mientras el estado es DECLINED (CHECK de la tabla).
    await prisma.conversation.update({ where: { id: convId }, data: { declinedAt } })
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

    const nombres: Record<Quien, string> = {
      pareja: 'Ana Pareja',
      prov: 'Pepe Proveedor',
      draft: 'Dani Borrador',
      otro: 'Olga Otra',
    }
    const crear = async (quien: Quien) => {
      const u = await prisma.user.create({
        data: { email: `${quien}@perfil.test`, passwordHash: 'x', fullName: nombres[quien] },
      })
      return { id: u.id, token: tokens.firmarAccess({ id: u.id, systemRole: u.systemRole }) }
    }
    const [pareja, prov, draft, otro] = await Promise.all([
      crear('pareja'),
      crear('prov'),
      crear('draft'),
      crear('otro'),
    ])
    id = { pareja: pareja.id, prov: prov.id, draft: draft.id, otro: otro.id }
    t = { pareja: pareja.token, prov: prov.token, draft: draft.token, otro: otro.token }

    const categoryId = await categoriaId(prisma, 'photography')
    const sembrar = async (userId: string, businessName: string, status: 'PUBLISHED' | 'DRAFT') =>
      (await prisma.vendorProfile.create({ data: { userId, businessName, categoryId, status } })).id
    // `pareja` también tiene ficha: hace falta para "el que rechazó pide desde la ficha del otro".
    ficha = {
      pareja: await sembrar(id.pareja, 'Ana Eventos', 'PUBLISHED'),
      prov: await sembrar(id.prov, 'Foto Pepe', 'PUBLISHED'),
      draft: await sembrar(id.draft, 'Borrador', 'DRAFT'),
    }
  }, 240_000)

  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
    await prisma.message.deleteMany()
    await prisma.conversation.deleteMany()
    await prisma.vendorProfile.update({ where: { id: ficha.prov }, data: { status: 'PUBLISHED' } })
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

  describe('el solicitante', () => {
    it('pide (201), ve PENDING_SENT, no puede pedir otra vez ni escribir', async () => {
      const antes = await estado(t.pareja, ficha.prov)
      expect(antes).toEqual({ state: 'NONE', conversationId: null, retryAt: null })

      const convId = await solicitud()

      expect(await estado(t.pareja, ficha.prov)).toEqual({
        state: 'PENDING_SENT',
        conversationId: convId,
        retryAt: null,
      })
      const repetido = await pedir(t.pareja, ficha.prov).expect(409)
      expect((repetido.body as ErrorCuerpo).code).toBe('CONTACT_REQUEST_PENDING')
      const escrito = await escribir(t.pareja, convId, 'otra cosa').expect(403)
      expect((escrito.body as ErrorCuerpo).code).toBe('CONTACT_REQUEST_PENDING')
    })
  })

  describe('el proveedor', () => {
    it('ve la solicitud con el texto completo y el nombre de la persona', async () => {
      const convId = await solicitud()

      const b = await bandeja(t.prov)

      expect(b.requestsPending).toBe(1)
      expect(b.items).toHaveLength(1)
      expect(b.items[0]).toMatchObject({
        id: convId,
        kind: 'PROFILE',
        status: 'PENDING',
        direction: 'RECEIVED',
        other: { userId: id.pareja, displayName: 'Ana Pareja' },
        lastMessage: { body: TEXTO_LARGO },
      })
    })

    it('no escribe antes de aceptar; al aceptar los dos escriben y se ven; aceptar otra vez es 409', async () => {
      const convId = await solicitud()
      const antes = await escribir(t.prov, convId, 'hola').expect(403)
      expect((antes.body as ErrorCuerpo).code).toBe('CONTACT_REQUEST_PENDING')

      const aceptada = await responder(t.prov, convId, 'accept').expect(200)
      expect(aceptada.body).toMatchObject({ id: convId, status: 'ACCEPTED' })
      await escribir(t.prov, convId, 'claro que sí').expect(201)
      await escribir(t.pareja, convId, 'genial').expect(201)

      // El historial viene del más nuevo al más viejo, como en la 1:1.
      const esperado = ['genial', 'claro que sí', TEXTO_LARGO]
      expect(await mensajes(t.pareja, convId)).toEqual(esperado)
      expect(await mensajes(t.prov, convId)).toEqual(esperado)
      const otra = await responder(t.prov, convId, 'accept').expect(409)
      expect((otra.body as ErrorCuerpo).code).toBe('CONTACT_REQUEST_NOT_PENDING')
    })
  })

  describe('rechazo y reintento', () => {
    it('rechazada: el solicitante ve DECLINED con retryAt, el proveedor ya no la ve, y espera 24 h', async () => {
      const convId = await solicitud()
      await responder(t.prov, convId, 'decline').expect(200)

      const mio = await estado(t.pareja, ficha.prov)
      expect(mio.state).toBe('DECLINED')
      expect(mio.retryAt).not.toBeNull()
      const sala = (await bandeja(t.pareja)).items[0]
      expect(sala).toMatchObject({ status: 'DECLINED', readOnly: true })
      expect(sala?.retryAt).toBe(mio.retryAt)
      expect((await bandeja(t.prov)).items).toEqual([])
      expect((await bandeja(t.prov)).requestsPending).toBe(0)
      await request(server).get(`/conversations/${convId}/messages`).set(como(t.prov)).expect(404)

      const cooldown = await pedir(t.pareja, ficha.prov).expect(409)
      expect((cooldown.body as ErrorCuerpo).code).toBe('CONTACT_REQUEST_COOLDOWN')
      expect((cooldown.body as ErrorCuerpo).details?.retryAt).toBe(mio.retryAt)

      await moverRechazoAtras24h(convId)
      const reintento = await pedir(t.pareja, ficha.prov, 'segundo intento').expect(201)
      expect((reintento.body as { conversation: ConversacionCuerpo }).conversation).toMatchObject({
        id: convId,
        status: 'PENDING',
      })
      const vista = await bandeja(t.prov)
      expect(vista.requestsPending).toBe(1)
      expect(await mensajes(t.prov, convId)).toEqual(['segundo intento', TEXTO_LARGO])
    })

    it('el proveedor que ya rechazó y vuelve a responder recibe 409, no 404', async () => {
      const convId = await solicitud()
      await responder(t.prov, convId, 'decline').expect(200)

      for (const accion of ['accept', 'decline'] as const) {
        const r = await responder(t.prov, convId, accion).expect(409)
        expect((r.body as ErrorCuerpo).code).toBe('CONTACT_REQUEST_NOT_PENDING')
      }
    })

    it('relación previa al volver a pedir, sin esperar: rechazada y luego relacionados, 201 y ACCEPTED', async () => {
      const convId = await solicitud()
      await responder(t.prov, convId, 'decline').expect(200)
      const categoryId = await categoriaId(prisma, 'photography')
      const evento = await prisma.event.create({
        data: {
          name: 'Boda tras rechazo',
          weddingDate: new Date(Date.now() + 180 * 86_400_000),
          ownerId: id.pareja,
          status: 'ACTIVE',
        },
      })
      try {
        await prisma.eventMembership.create({
          data: { eventId: evento.id, userId: id.pareja, role: 'COUPLE' },
        })
        await prisma.eventVendor.create({
          data: { eventId: evento.id, vendorProfileId: ficha.prov, categoryId, status: 'BOOKED' },
        })

        // Inmediato: sin mover `declinedAt`, la relación salta la espera de 24 h.
        const r = await pedir(t.pareja, ficha.prov, 'ya nos conocemos').expect(201)

        expect((r.body as { conversation: ConversacionCuerpo }).conversation).toMatchObject({
          id: convId,
          status: 'ACCEPTED',
        })
        await escribir(t.prov, convId, 'hola').expect(201)
      } finally {
        await prisma.event.delete({ where: { id: evento.id } })
      }
    })

    it('quien rechazó no puede pedir desde la ficha del otro (CONTACT_DECLINED_BY_YOU)', async () => {
      const convId = await solicitud()
      await responder(t.prov, convId, 'decline').expect(200)

      const r = await pedir(t.prov, ficha.pareja).expect(409)

      expect((r.body as ErrorCuerpo).code).toBe('CONTACT_DECLINED_BY_YOU')
      expect(await estado(t.prov, ficha.pareja)).toMatchObject({
        state: 'DECLINED_BY_ME',
        retryAt: null,
      })
    })
  })

  describe('quien no es parte, y sin sesión', () => {
    it('un tercero recibe 404 al leer, aceptar o rechazar', async () => {
      const convId = await solicitud()

      await request(server).get(`/conversations/${convId}/messages`).set(como(t.otro)).expect(404)
      await responder(t.otro, convId, 'accept').expect(404)
      await responder(t.otro, convId, 'decline').expect(404)
    })

    it('un id que no es UUID es 404 en las rutas nuevas', async () => {
      await request(server).get('/vendors/no-uuid/contact').set(como(t.pareja)).expect(404)
      await pedir(t.pareja, 'no-uuid').expect(404)
      await responder(t.prov, 'no-uuid', 'accept').expect(404)
    })

    it('las cinco rutas nuevas exigen sesión y la ficha pública sigue abierta', async () => {
      await request(server).get(`/vendors/${ficha.prov}/contact`).expect(401)
      await request(server)
        .post(`/vendors/${ficha.prov}/contact`)
        .send({ body: 'hola' })
        .expect(401)
      await request(server).post(`/conversations/${ID_INEXISTENTE}/accept`).expect(401)
      await request(server).post(`/conversations/${ID_INEXISTENTE}/decline`).expect(401)
      await request(server).get('/me/profile-conversations').expect(401)
      await request(server).get(`/vendors/${ficha.prov}`).expect(200)
    })
  })

  describe('ficha despublicada', () => {
    const despublicar = () =>
      prisma.vendorProfile.update({ where: { id: ficha.prov }, data: { status: 'DRAFT' } })

    it('no se puede pedir (404), pero una pendiente previa aún se acepta y una aceptada sigue escribiendo', async () => {
      const pendiente = await solicitud()
      await despublicar()

      const nueva = await pedir(t.otro, ficha.prov).expect(404)
      expect((nueva.body as ErrorCuerpo).code).toBe('VENDOR_PROFILE_NOT_FOUND')
      expect(await estado(t.pareja, ficha.prov)).toMatchObject({
        state: 'PENDING_SENT',
        conversationId: pendiente,
      })

      await responder(t.prov, pendiente, 'accept').expect(200)
      await escribir(t.pareja, pendiente, 'sigue funcionando').expect(201)
      await escribir(t.prov, pendiente, 'y por aquí').expect(201)
      expect(await estado(t.pareja, ficha.prov)).toMatchObject({
        state: 'ACCEPTED',
        conversationId: pendiente,
      })
    })
  })

  describe('relación previa', () => {
    it('quien ya comparte evento con el proveedor nace ACCEPTED; la EVENT_DIRECT es otra', async () => {
      const categoryId = await categoriaId(prisma, 'photography')
      const evento = await prisma.event.create({
        data: {
          name: 'Boda de Ana',
          weddingDate: new Date(Date.now() + 180 * 86_400_000),
          ownerId: id.pareja,
          status: 'ACTIVE',
        },
      })
      try {
        await prisma.eventMembership.create({
          data: { eventId: evento.id, userId: id.pareja, role: 'COUPLE' },
        })
        await prisma.eventVendor.create({
          data: { eventId: evento.id, vendorProfileId: ficha.prov, categoryId, status: 'BOOKED' },
        })
        const directa = await request(server)
          .post(`/events/${evento.id}/conversations`)
          .set(como(t.pareja))
          .send({ userId: id.prov })
          .expect(201)
        const directaId = (directa.body as { id: string }).id

        const r = await pedir(t.pareja, ficha.prov).expect(201)

        const perfil = (r.body as { conversation: ConversacionCuerpo }).conversation
        expect(perfil.status).toBe('ACCEPTED')
        expect(perfil.id).not.toBe(directaId)
        expect(await prisma.conversation.count({ where: { kind: 'PROFILE' } })).toBe(1)
        expect(await prisma.conversation.count({ where: { kind: 'EVENT_DIRECT' } })).toBe(1)
        await escribir(t.prov, perfil.id, 'hola de nuevo').expect(201)
      } finally {
        await prisma.event.delete({ where: { id: evento.id } })
      }
    })
  })

  it('el autocontacto es 422 y GET contact responde SELF', async () => {
    const r = await pedir(t.prov, ficha.prov).expect(422)

    expect((r.body as ErrorCuerpo).code).toBe('CONTACT_SELF')
    expect(await estado(t.prov, ficha.prov)).toEqual({
      state: 'SELF',
      conversationId: null,
      retryAt: null,
    })
  })

  describe('límite por usuario', () => {
    const quitarRequestId = (b: unknown): unknown => {
      const { requestId: _omitido, ...resto } = b as ErrorCuerpo
      return resto
    }

    it('la petición 11.ª de un usuario es 429 aunque las anteriores fallaran; otro usuario de la misma IP pasa', async () => {
      for (let i = 0; i < 10; i++) await pedir(t.pareja, ficha.draft).expect(404)

      const cortado = await pedir(t.pareja, ficha.prov).expect(429)

      await pedir(t.otro, ficha.draft).expect(404)
      // Y la 429 tiene la misma forma que la del limitador global.
      await limpiarContadoresDeRitmo(redis.getConnectionUrl())
      let global = await request(server).get(`/vendors/${ficha.prov}`)
      for (let i = 0; i < 125 && global.status !== 429; i++) {
        global = await request(server).get(`/vendors/${ficha.prov}`)
      }
      expect(global.status).toBe(429)
      expect(quitarRequestId(cortado.body)).toEqual(quitarRequestId(global.body))
      // Y las dos dicen cuándo reintentar, en segundos. La de `ThrottlerGuard` (la
      // corta aquí `vendor-profile`, antes que `global`) sólo trae
      // `Retry-After-vendor-profile`; la por usuario trae `Retry-After` Y
      // `Retry-After-contact-requests`.
      const segundos = (v: unknown): number => Number(v)
      expect(segundos(global.headers['retry-after-vendor-profile'])).toBeGreaterThan(0)
      expect(segundos(cortado.headers['retry-after-contact-requests'])).toBeGreaterThan(0)
      expect(segundos(cortado.headers['retry-after-contact-requests'])).toBeLessThanOrEqual(3600)
      expect(cortado.headers['retry-after']).toBe(cortado.headers['retry-after-contact-requests'])
    })

    it('un bearer con firma inválida es 401 y no gasta el cupo de nadie', async () => {
      const [cabecera, carga] = t.pareja.split('.')
      const falso = `${cabecera ?? ''}.${carga ?? ''}.firma-que-no-es`
      for (let i = 0; i < 12; i++) {
        await request(server)
          .post(`/vendors/${ficha.draft}/contact`)
          .set(como(falso))
          .send({ body: 'hola' })
          .expect(401)
      }

      for (let i = 0; i < 10; i++) await pedir(t.pareja, ficha.draft).expect(404)
      await pedir(t.pareja, ficha.draft).expect(429)
    })
  })

  it('GET /me/conversations y /me/rooms no incluyen nunca una conversación PROFILE', async () => {
    const convId = await solicitud()
    await responder(t.prov, convId, 'accept').expect(200)

    for (const token of [t.pareja, t.prov]) {
      for (const ruta of ['/me/conversations', '/me/rooms']) {
        const r = await request(server).get(ruta).set(como(token)).expect(200)
        const items = (r.body as { items: Array<{ id: string; kind: string }> }).items
        expect(items.filter((c) => c.id === convId || c.kind === 'PROFILE')).toEqual([])
      }
    }
  })

  describe('tiempo real', () => {
    async function conectarComo(token: string): Promise<Recibido[]> {
      const socket = io(`${url}/realtime`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      })
      abiertos.push(socket)
      const recibidos: Recibido[] = []
      socket.onAny((evento: string, datos: unknown) => recibidos.push({ evento, datos }))
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('connect_error', reject)
      })
      return recibidos
    }

    /** Espera a que haya `n` avisos de `evento`; el worker es otro hilo asíncrono. */
    async function esperar(recibidos: Recibido[], evento: string, n = 1): Promise<unknown[]> {
      const limite = Date.now() + 10_000
      while (recibidos.filter((r) => r.evento === evento).length < n) {
        if (Date.now() > limite) {
          throw new Error(`no llegaron ${n} ${evento}; hay ${JSON.stringify(recibidos)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return recibidos.filter((r) => r.evento === evento).map((r) => r.datos)
    }

    const cuantos = (recibidos: Recibido[], evento: string): number =>
      recibidos.filter((r) => r.evento === evento).length

    it('el proveedor recibe message.created y contact.updated al llegar la solicitud', async () => {
      const prov = await conectarComo(t.prov)

      const convId = await solicitud()

      const [creado] = await esperar(prov, 'message.created')
      expect(creado).toMatchObject({ conversationId: convId, message: { body: TEXTO_LARGO } })
      expect(await esperar(prov, 'contact.updated')).toEqual([{ conversationId: convId }])
    })

    it('el solicitante recibe contact.updated al aceptar, y al rechazar; un reintento vuelve a llegar al proveedor', async () => {
      const pareja = await conectarComo(t.pareja)
      const prov = await conectarComo(t.prov)
      const convId = await solicitud()
      await esperar(prov, 'message.created', 1)
      await esperar(prov, 'contact.updated', 1)
      await esperar(pareja, 'contact.updated', 1)

      await responder(t.prov, convId, 'accept').expect(200)
      expect(await esperar(pareja, 'contact.updated', 2)).toEqual([
        { conversationId: convId },
        { conversationId: convId },
      ])
      // El proveedor también recibe el aviso de su propia aceptación: se espera
      // ANTES de vaciar los buzones, o llegaría tarde y contaminaría el segundo tramo.
      await esperar(prov, 'contact.updated', 2)

      // Otra solicitud, esta vez rechazada.
      await prisma.conversation.deleteMany()
      pareja.length = 0
      prov.length = 0
      const segunda = await solicitud()
      await esperar(prov, 'message.created', 1)
      await esperar(pareja, 'contact.updated', 1)
      await responder(t.prov, segunda, 'decline').expect(200)
      expect(await esperar(pareja, 'contact.updated', 2)).toEqual([
        { conversationId: segunda },
        { conversationId: segunda },
      ])
      // El proveedor, que ya no la ve, sí se entera de que desapareció.
      await esperar(prov, 'contact.updated', 2)

      await moverRechazoAtras24h(segunda)
      const antes = cuantos(prov, 'message.created')
      await pedir(t.pareja, ficha.prov, 'segundo intento').expect(201)
      await esperar(prov, 'message.created', antes + 1)
    })
  })
})
