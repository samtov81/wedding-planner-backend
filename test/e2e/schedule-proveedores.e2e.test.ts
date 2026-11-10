import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Stream } from 'node:stream'

import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { Queue } from 'bullmq'
import { io, type Socket as SocketCliente } from 'socket.io-client'
import request from 'supertest'

import { AppModule } from '@/app.module'
import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { configurarApp, OPCIONES_DE_FABRICA } from '@/configurar-app'
import { TokenService } from '@/modules/auth/application/token.service'
import {
  COLA_CRONOGRAMA,
  jobIdDeRecordatorio,
} from '@/modules/schedule/application/avisos-cronograma'
import { GENERADOR_PDF } from '@/modules/schedule/application/pdf.port'
import { ANTELACION_RECORDATORIO_MS } from '@/modules/schedule/domain/participacion'
import { PdfkitCronograma } from '@/modules/schedule/infrastructure/pdfkit-cronograma'

import { fijarEntorno } from '../support/app'
import { categoriaId } from '../support/categorias'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { textoDelPdf } from '../support/texto-pdf'
import { limpiarContadoresDeRitmo } from '../support/throttler'

interface ItemCuerpo {
  id: string
  title: string
  startsAt: string
  endsAt: string | null
  vendors: Array<{ eventVendorId: string; name: string; categoryName: string; confirmed: boolean }>
  noteCount?: number
}

interface ConfirmacionesCuerpo {
  ready: number
  total: number
  vendors: Array<{ userId: string; name: string; avatarUrl: string | null; ready: boolean }>
  mine: { pending: Array<{ itemId: string; startsAt: string; endsAt: string | null }> } | null
}

interface CampanaCuerpo {
  items: Array<{ type: string; payload: unknown; event: { id: string } }>
}

interface ErrorCuerpo {
  code: string
  details?: unknown
}

type Actor = 'creador' | 'pareja' | 'planner' | 'provA' | 'provB' | 'provC' | 'extrano' | 'admin'

/**
 * Los seis perfiles de la matriz (spec 2026-11-10 §3). A tiene dos
 * contrataciones `BOOKED` y sólo una (A1) está asignada al ítem de la matriz;
 * B está contratado sin asignar. C (SHORTLISTED) y el admin quedan fuera de
 * la matriz: C no tiene acceso al evento y el admin tiene su propio caso.
 */
const PERFILES = [
  ['creador', 'creador'],
  ['pareja no creadora', 'pareja'],
  ['planner no creador', 'planner'],
  ['proveedor A (asignado)', 'provA'],
  ['proveedor B (sin asignar)', 'provB'],
  ['extraño', 'extrano'],
] as const satisfies ReadonlyArray<readonly [string, Actor]>

type Perfil = (typeof PERFILES)[number][1]

const NOMBRE_DE_PERFIL = new Map<Perfil, string>(
  PERFILES.map(([nombre, perfil]) => [perfil, nombre]),
)

type Metodo = 'get' | 'post' | 'patch' | 'put' | 'delete'

interface Contexto {
  eventId: string
  itemId: string
  contratacionA1: string
}

interface Esperado {
  status: number
  cuerpo?: (cuerpo: unknown) => void
}

const conCodigo = (status: number, code: string): Esperado => ({
  status,
  cuerpo: (c) => expect((c as ErrorCuerpo).code).toBe(code),
})

/** "T": todos los del evento; fuera de él, 404. */
function todos(ok: number): Record<Perfil, Esperado> {
  return {
    creador: { status: ok },
    pareja: { status: ok },
    planner: { status: ok },
    provA: { status: ok },
    provB: { status: ok },
    extrano: { status: 404 },
  }
}

/** "M": miembros sí, proveedores 403 del guard, fuera del evento 404. */
function miembros(ok: number): Record<Perfil, Esperado> {
  return { ...todos(ok), provA: { status: 403 }, provB: { status: 403 } }
}

/** "P": como M, y la pareja recibe 403 `SCHEDULE_PLANNER_ONLY` del caso de uso. */
function soloPlanner(ok: number): Record<Perfil, Esperado> {
  return { ...miembros(ok), pareja: conCodigo(403, 'SCHEDULE_PLANNER_ONLY') }
}

/** Notas: para quien no es planner "no existen" (spec §3): 404 con el código del ítem. */
function notas(ok: number): Record<Perfil, Esperado> {
  const noExiste = conCodigo(404, 'SCHEDULE_ITEM_NOT_FOUND')
  return { ...todos(ok), pareja: noExiste, provA: noExiste, provB: noExiste }
}

const RUTAS: ReadonlyArray<
  readonly [string, (ctx: Contexto) => [Metodo, string, object?], Record<Perfil, Esperado>]
> = [
  ['GET /', (c) => ['get', `/events/${c.eventId}/schedule`], todos(200)],
  [
    'POST /',
    (c) => [
      'post',
      `/events/${c.eventId}/schedule`,
      { title: 'Nuevo', startsAt: '2027-06-12T20:00:00Z' },
    ],
    miembros(201),
  ],
  [
    'PATCH /:itemId',
    (c) => ['patch', `/events/${c.eventId}/schedule/${c.itemId}`, { title: 'Renombrado' }],
    miembros(200),
  ],
  [
    'DELETE /:itemId',
    (c) => ['delete', `/events/${c.eventId}/schedule/${c.itemId}`],
    miembros(204),
  ],
  [
    'PUT /:itemId/vendors',
    (c) => [
      'put',
      `/events/${c.eventId}/schedule/${c.itemId}/vendors`,
      { eventVendorIds: [c.contratacionA1] },
    ],
    soloPlanner(200),
  ],
  [
    'GET /assignable-vendors',
    (c) => ['get', `/events/${c.eventId}/schedule/assignable-vendors`],
    soloPlanner(200),
  ],
  [
    'GET /:itemId/notes',
    (c) => ['get', `/events/${c.eventId}/schedule/${c.itemId}/notes`],
    notas(200),
  ],
  [
    'POST /:itemId/notes',
    (c) => ['post', `/events/${c.eventId}/schedule/${c.itemId}/notes`, { body: 'Ojo' }],
    notas(201),
  ],
  ['GET /confirmations', (c) => ['get', `/events/${c.eventId}/schedule/confirmations`], todos(200)],
  [
    'POST /confirmations',
    (c) => ['post', `/events/${c.eventId}/schedule/confirmations`, { items: [] }],
    {
      creador: { status: 403 },
      pareja: { status: 403 },
      planner: { status: 403 },
      provA: { status: 200 },
      provB: { status: 200 },
      extrano: { status: 404 },
    },
  ],
  [
    'POST /notify-vendors',
    (c) => ['post', `/events/${c.eventId}/schedule/notify-vendors`],
    soloPlanner(200),
  ],
  ['GET /pdf', (c) => ['get', `/events/${c.eventId}/schedule/pdf`], todos(200)],
]

const CASOS = RUTAS.flatMap(([ruta, peticion, esperados]) =>
  (Object.entries(esperados) as Array<[Perfil, Esperado]>).map(([perfil, esperado]) => ({
    ruta,
    nombre: NOMBRE_DE_PERFIL.get(perfil),
    perfil,
    peticion,
    esperado,
  })),
)

/** Recoge el cuerpo binario entero: supertest no bufferiza `application/pdf` por su cuenta. */
function binario(res: Stream, listo: (error: Error | null, cuerpo: Buffer) => void): void {
  const trozos: Buffer[] = []
  res.on('data', (t: Buffer) => trozos.push(t))
  res.on('end', () => listo(null, Buffer.concat(trozos)))
}

/**
 * El cronograma con proveedores a través de la app real (HTTP + Socket.IO +
 * worker de BullMQ + Postgres + Redis), spec 2026-11-10. La app se construye
 * como en `main.ts` salvo UN provider: `GENERADOR_PDF` pasa a
 * `PdfkitCronograma({ compress: false })`, el MISMO adaptador con los flujos
 * sin comprimir, para que `textoDelPdf` pueda leer si una nota está o no
 * (Review Focus 5). Alternativa descartada: un generador falso que guarde el
 * `DocumentoCronograma`; probaría la composición pero no los bytes que se
 * descargan, que es lo que la spec promete ("ni un byte de notas").
 *
 * Los recordatorios no se acortan con un reloj inyectado: el ítem se crea a
 * `ahora + 15 min + unos segundos`, así que el job diferido real se dispara en
 * esos segundos y lo procesa el worker real. Alternativa descartada: un token
 * con `ANTELACION` corta sólo en test, que dejaría sin probar el valor que se
 * despliega.
 */
describe('cronograma con proveedores e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let app: NestExpressApplication
  let server: Server
  let url: string
  let prisma: PrismaClient
  let cola: Queue
  const abiertos: SocketCliente[] = []

  let eventId: string
  const tokens = new Map<Actor, string>()
  let id: Record<Actor, string>
  let contratacionA1: string
  let contratacionA2: string
  let contratacionB: string
  let contratacionC: string

  function tokenDe(actor: Actor): string {
    const token = tokens.get(actor)
    if (!token) throw new Error(`sin token para ${actor}`)
    return token
  }
  const como = (actor: Actor) => ({ Authorization: `Bearer ${tokenDe(actor)}` })
  const base = () => `/events/${eventId}/schedule`

  async function crearItem(
    datos: { title: string; startsAt: string; eventVendorIds?: string[] },
    quien: Actor = 'creador',
  ): Promise<ItemCuerpo> {
    const r = await request(server).post(base()).set(como(quien)).send(datos).expect(201)
    return r.body as ItemCuerpo
  }

  async function asignar(itemId: string, eventVendorIds: string[]): Promise<ItemCuerpo> {
    const r = await request(server)
      .put(`${base()}/${itemId}/vendors`)
      .set(como('creador'))
      .send({ eventVendorIds })
      .expect(200)
    return r.body as ItemCuerpo
  }

  async function confirmaciones(quien: Actor): Promise<ConfirmacionesCuerpo> {
    const r = await request(server).get(`${base()}/confirmations`).set(como(quien)).expect(200)
    return r.body as ConfirmacionesCuerpo
  }

  async function confirmar(
    quien: Actor,
    items: Array<{ itemId: string; startsAt: string; endsAt: string | null }>,
  ): Promise<ConfirmacionesCuerpo> {
    const r = await request(server)
      .post(`${base()}/confirmations`)
      .set(como(quien))
      .send({ items })
      .expect(200)
    return r.body as ConfirmacionesCuerpo
  }

  async function lista(quien: Actor): Promise<ItemCuerpo[]> {
    const r = await request(server).get(base()).set(como(quien)).expect(200)
    return r.body as ItemCuerpo[]
  }

  async function campana(quien: Actor, tipo: string): Promise<CampanaCuerpo['items']> {
    const r = await request(server).get('/me/notifications').set(como(quien)).expect(200)
    return (r.body as CampanaCuerpo).items.filter((n) => n.type === tipo)
  }

  async function pdfDe(quien: Actor): Promise<string> {
    const r = await request(server)
      .get(`${base()}/pdf`)
      .set(como(quien))
      .buffer(true)
      .parse(binario)
      .expect(200)
    return textoDelPdf(r.body as Buffer)
  }

  async function cambiarContratacion(
    eventVendorId: string,
    status: 'BOOKED' | 'CANCELLED',
  ): Promise<void> {
    await request(server)
      .patch(`/events/${eventId}/vendors/${eventVendorId}`)
      .set(como('creador'))
      .send({ status })
      .expect(200)
  }

  /** El socket del usuario: `notification.created` llega por `user:<id>`, sin `join`. */
  async function conectarComo(actor: Actor): Promise<SocketCliente> {
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
    return socket
  }

  /** El primer `evento` cuyo payload cumple `filtro`, o falla a los `ms`. */
  function esperar(
    socket: SocketCliente,
    evento: string,
    filtro: (datos: unknown) => boolean = () => true,
    ms = 15_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const oyente = (datos: unknown) => {
        if (!filtro(datos)) return
        clearTimeout(reloj)
        socket.off(evento, oyente)
        resolve(datos)
      }
      const reloj = setTimeout(() => {
        socket.off(evento, oyente)
        reject(new Error(`no llegó ${evento} en ${ms} ms`))
      }, ms)
      socket.on(evento, oyente)
    })
  }

  const esDeTipo = (tipo: string) => (datos: unknown) => (datos as { type?: string }).type === tipo

  function abrirPeticion(metodo: Metodo, ruta: string): request.Test {
    switch (metodo) {
      case 'get':
        return request(server).get(ruta)
      case 'post':
        return request(server).post(ruta)
      case 'patch':
        return request(server).patch(ruta)
      case 'put':
        return request(server).put(ruta)
      case 'delete':
        return request(server).delete(ruta)
    }
  }

  const pausa = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  /**
   * Espera ACOTADA a que el worker termine un job concreto. Para afirmar que
   * un recordatorio NO llega no basta una pausa a ciegas: aquí se sabe que el
   * worker ya lo procesó (y lo descartó) cuando se mira la campana.
   */
  async function jobTerminado(jobId: string, ms = 15_000): Promise<void> {
    const limite = Date.now() + ms
    while (Date.now() < limite) {
      const job = await cola.getJob(jobId)
      if (job === undefined) throw new Error(`no existe el job ${jobId}`)
      if (await job.isCompleted()) return
      await pausa(200)
    }
    throw new Error(`el job ${jobId} no terminó en ${ms} ms`)
  }

  /** Una hora cuyo recordatorio (−15 min) cae dentro de `segundos`. */
  const dentroDe = (segundos: number) =>
    new Date(Date.now() + ANTELACION_RECORDATORIO_MS + segundos * 1000).toISOString()

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })

    const modulo = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GENERADOR_PDF)
      .useValue(new PdfkitCronograma({ compress: false }))
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
    cola = new Queue(COLA_CRONOGRAMA, { connection: { url: redis.getConnectionUrl() } })

    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const firmador = app.get(TokenService)
    const nombres: Array<[Actor, string]> = Object.entries({
      creador: 'Creador',
      pareja: 'Pareja',
      planner: 'Planner',
      provA: 'Proveedor A',
      provB: 'Proveedor B',
      provC: 'Proveedor C',
      extrano: 'Extraño',
      admin: 'Admin',
    } satisfies Record<Actor, string>) as Array<[Actor, string]>
    const creados = await Promise.all(
      nombres.map(async ([actor, nombre]) => {
        const u = await prisma.user.create({
          data: {
            email: `${actor}@schedule-proveedores.test`,
            passwordHash: 'x',
            fullName: nombre,
            ...(actor === 'admin' ? { systemRole: 'ADMIN' as const } : {}),
          },
        })
        const token = firmador.firmarAccess({ id: u.id, systemRole: u.systemRole })
        return [actor, { id: u.id, token }] as const
      }),
    )
    id = Object.fromEntries(creados.map(([actor, u]) => [actor, u.id])) as Record<Actor, string>
    for (const [actor, u] of creados) tokens.set(actor, u.token)

    eventId = (
      await prisma.event.create({
        data: {
          name: 'Boda con proveedores',
          weddingDate: new Date('2027-06-12T00:00:00Z'),
          timezone: 'America/Bogota',
          ownerId: id.creador,
          status: 'ACTIVE',
        },
      })
    ).id
    await prisma.eventMembership.createMany({
      data: [
        { eventId, userId: id.creador, role: 'PLANNER' },
        { eventId, userId: id.pareja, role: 'COUPLE' },
        { eventId, userId: id.planner, role: 'PLANNER' },
      ],
    })

    const decor = await categoriaId(prisma, 'decor-floral')
    const venue = await categoriaId(prisma, 'venue')
    const foto = await categoriaId(prisma, 'photography')
    const ficha = async (userId: string, businessName: string, cat: string) =>
      (
        await prisma.vendorProfile.create({
          data: { userId, businessName, categoryId: cat, status: 'PUBLISHED' },
        })
      ).id
    const contratar = async (
      vendorProfileId: string,
      cat: string,
      status: 'BOOKED' | 'SHORTLISTED',
    ) =>
      (
        await prisma.eventVendor.create({
          data: { eventId, vendorProfileId, categoryId: cat, status },
        })
      ).id
    const fichaA = await ficha(id.provA, 'Flores A', decor)
    contratacionA1 = await contratar(fichaA, decor, 'BOOKED')
    contratacionA2 = await contratar(fichaA, venue, 'BOOKED')
    contratacionB = await contratar(await ficha(id.provB, 'Fotos B', foto), foto, 'BOOKED')
    contratacionC = await contratar(await ficha(id.provC, 'Velas C', decor), decor, 'SHORTLISTED')
  }, 240_000)

  /**
   * Cada caso parte de un cronograma vacío, una campana vacía, contadores de
   * ritmo a cero y A1 `BOOKED` (la recontratación la cancela por el camino).
   */
  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
    await prisma.scheduleItemNote.deleteMany()
    await prisma.scheduleItemVendor.deleteMany()
    await prisma.scheduleItem.deleteMany()
    await prisma.notification.deleteMany()
    await prisma.eventVendor.update({ where: { id: contratacionA1 }, data: { status: 'BOOKED' } })
  })

  afterEach(() => {
    for (const socket of abiertos.splice(0)) socket.disconnect()
  })

  afterAll(async () => {
    await cola.close()
    await prisma.$disconnect()
    await app.close()
    await redis.stop()
    await pg.stop()
  })

  describe('matriz de acceso (spec 2026-11-10 §3)', () => {
    let ctx: Contexto

    beforeEach(async () => {
      const item = await crearItem({
        title: 'Ítem de la matriz',
        startsAt: '2027-06-12T22:00:00Z',
        eventVendorIds: [contratacionA1],
      })
      ctx = { eventId, itemId: item.id, contratacionA1 }
    })

    it.each(CASOS)('$ruta como $nombre → $esperado.status', async (caso) => {
      const [metodo, ruta, cuerpo] = caso.peticion(ctx)
      const peticion = abrirPeticion(metodo, ruta).set(como(caso.perfil))
      const r = await (cuerpo === undefined ? peticion : peticion.send(cuerpo))
      expect(r.status).toBe(caso.esperado.status)
      caso.esperado.cuerpo?.(r.body)
    })

    it('sin token, 401', async () => {
      await request(server).get(base()).expect(401)
    })

    it('un admin no miembro usa las rutas del planner: notas, asignar, avisar y noteCount', async () => {
      const nota = await request(server)
        .post(`${base()}/${ctx.itemId}/notes`)
        .set(como('admin'))
        .send({ body: 'Revisar sonido' })
        .expect(201)
      expect(nota.body).toMatchObject({ itemId: ctx.itemId, author: { id: id.admin } })
      const notasAdmin = await request(server)
        .get(`${base()}/${ctx.itemId}/notes`)
        .set(como('admin'))
        .expect(200)
      expect(notasAdmin.body).toHaveLength(1)

      const asignado = await request(server)
        .put(`${base()}/${ctx.itemId}/vendors`)
        .set(como('admin'))
        .send({ eventVendorIds: [contratacionA1, contratacionB] })
        .expect(200)
      expect((asignado.body as ItemCuerpo).vendors.map((v) => v.eventVendorId).sort()).toEqual(
        [contratacionA1, contratacionB].sort(),
      )

      const aviso = await request(server)
        .post(`${base()}/notify-vendors`)
        .set(como('admin'))
        .expect(200)
      expect(aviso.body).toEqual({ notified: 2 })
      expect(await lista('admin')).toEqual([
        expect.objectContaining({ id: ctx.itemId, noteCount: 1 }),
      ])
    })
  })

  describe('notas del planner (Review Focus 5)', () => {
    const NOTA = 'Secreto del planner: propina en sobre azul'

    it('pareja, A y B no ven ni la nota, ni noteCount, ni su texto en el PDF; los planners sí', async () => {
      const item = await crearItem({
        title: 'Cena de bienvenida',
        startsAt: '2027-06-12T23:00:00Z',
        eventVendorIds: [contratacionA1],
      })
      await request(server)
        .post(`${base()}/${item.id}/notes`)
        .set(como('planner'))
        .send({ body: NOTA })
        .expect(201)

      for (const quien of ['pareja', 'provA', 'provB'] as const) {
        for (const peticion of [
          request(server).get(`${base()}/${item.id}/notes`).set(como(quien)),
          request(server).post(`${base()}/${item.id}/notes`).set(como(quien)).send({ body: 'x' }),
        ]) {
          const r = await peticion.expect(404)
          expect((r.body as ErrorCuerpo).code).toBe('SCHEDULE_ITEM_NOT_FOUND')
        }
        const suya = await lista(quien)
        expect(suya).toHaveLength(1)
        expect(suya[0]).not.toHaveProperty('noteCount')
        expect(JSON.stringify(suya)).not.toContain(NOTA)
      }
      for (const quien of ['creador', 'planner'] as const) {
        expect(await lista(quien)).toEqual([expect.objectContaining({ id: item.id, noteCount: 1 })])
      }

      // Control positivo: el PDF del planner SÍ lleva la nota, así que leerlo funciona.
      const delPlanner = await pdfDe('planner')
      expect(delPlanner).toContain('Cena de bienvenida')
      expect(delPlanner).toContain(NOTA)
      for (const quien of ['pareja', 'provA', 'provB'] as const) {
        const texto = await pdfDe(quien)
        expect(texto).toContain('Cena de bienvenida')
        expect(texto).not.toContain(NOTA)
        expect(texto).not.toContain('Notes:')
      }
    })

    it('GET /pdf → 200 application/pdf, timeline-<fecha>.pdf y sin caché compartida', async () => {
      await crearItem({ title: 'Ceremonia', startsAt: '2027-06-12T21:00:00Z' })
      const r = await request(server)
        .get(`${base()}/pdf`)
        .set(como('pareja'))
        .buffer(true)
        .parse(binario)
        .expect(200)
      expect(r.headers['content-type']).toBe('application/pdf')
      // Boda el 2027-06-12 en America/Bogota: la fecha de calendario, no el 11.
      expect(r.headers['content-disposition']).toBe(
        'attachment; filename="timeline-2027-06-12.pdf"',
      )
      expect(r.headers['cache-control']).toBe('private, no-store')
      expect((r.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    })
  })

  describe('asignar', () => {
    it('una contratación SHORTLISTED (C) → 422 SCHEDULE_VENDOR_NOT_ASSIGNABLE y nada se aplica', async () => {
      const item = await crearItem({ title: 'Velas', startsAt: '2027-06-12T22:30:00Z' })
      const r = await request(server)
        .put(`${base()}/${item.id}/vendors`)
        .set(como('creador'))
        .send({ eventVendorIds: [contratacionA1, contratacionC] })
        .expect(422)
      expect(r.body).toMatchObject({
        code: 'SCHEDULE_VENDOR_NOT_ASSIGNABLE',
        details: { eventVendorIds: [contratacionC] },
      })
      expect((await lista('creador'))[0]?.vendors).toEqual([])
    })

    it('más de 50 eventVendorIds → 400 al asignar y al crear', async () => {
      const item = await crearItem({ title: 'Tope', startsAt: '2027-06-12T22:30:00Z' })
      const muchos = Array.from({ length: 51 }, () => randomUUID())
      await request(server)
        .put(`${base()}/${item.id}/vendors`)
        .set(como('creador'))
        .send({ eventVendorIds: muchos })
        .expect(400)
      await request(server)
        .post(base())
        .set(como('creador'))
        .send({ title: 'Tope', startsAt: '2027-06-12T22:30:00Z', eventVendorIds: muchos })
        .expect(400)
    })
  })

  describe('confirmaciones (spec 2026-11-10 §4)', () => {
    it('A confirma, el planner cambia la hora: campana rescheduled y vuelve a pendiente', async () => {
      const item = await crearItem({
        title: 'Primer baile',
        startsAt: '2027-06-12T23:30:00Z',
        eventVendorIds: [contratacionA1],
      })
      const antes = await confirmaciones('provA')
      expect(antes).toMatchObject({ ready: 0, total: 1 })
      const vistos = antes.mine?.pending ?? []
      expect(vistos).toEqual([
        { itemId: item.id, startsAt: '2027-06-12T23:30:00.000Z', endsAt: null },
      ])

      expect(await confirmar('provA', vistos)).toMatchObject({
        ready: 1,
        total: 1,
        mine: { pending: [] },
      })

      // Título no desconfirma; la hora sí.
      await request(server)
        .patch(`${base()}/${item.id}`)
        .set(como('creador'))
        .send({ title: 'Primer baile de los novios' })
        .expect(200)
      expect(await confirmaciones('pareja')).toMatchObject({ ready: 1, total: 1 })
      expect(await campana('provA', 'schedule.item.rescheduled')).toEqual([])

      await request(server)
        .patch(`${base()}/${item.id}`)
        .set(como('planner'))
        .send({ startsAt: '2027-06-12T23:45:00Z' })
        .expect(200)
      const avisos = await campana('provA', 'schedule.item.rescheduled')
      expect(avisos).toHaveLength(1)
      expect(avisos[0]?.payload).toEqual({
        scheduleItemId: item.id,
        title: 'Primer baile de los novios',
      })
      expect(avisos[0]?.event.id).toBe(eventId)
      expect(await campana('provB', 'schedule.item.rescheduled')).toEqual([])

      const despues = await confirmaciones('provA')
      expect(despues).toMatchObject({ ready: 0, total: 1 })
      expect(despues.mine?.pending).toEqual([
        { itemId: item.id, startsAt: '2027-06-12T23:45:00.000Z', endsAt: null },
      ])

      // Review Focus 1: confirmar lo que vio ANTES del cambio no confirma la hora nueva.
      expect(await confirmar('provA', vistos)).toMatchObject({
        ready: 0,
        total: 1,
        mine: { pending: [{ itemId: item.id, startsAt: '2027-06-12T23:45:00.000Z' }] },
      })
      expect((await lista('pareja'))[0]?.vendors).toEqual([
        expect.objectContaining({ eventVendorId: contratacionA1, confirmed: false }),
      ])

      expect(await confirmar('provA', despues.mine?.pending ?? [])).toMatchObject({
        ready: 1,
        total: 1,
      })
    })

    it('más de 500 ítems en POST /confirmations → 400', async () => {
      const items = Array.from({ length: 501 }, () => ({
        itemId: randomUUID(),
        startsAt: '2027-06-12T23:30:00Z',
        endsAt: null,
      }))
      await request(server)
        .post(`${base()}/confirmations`)
        .set(como('provA'))
        .send({ items })
        .expect(400)
    })
  })

  describe('Notify Vendors (spec 2026-11-10 §6)', () => {
    it('avisa a A en vivo y en la campana; la sexta pulsación en una hora → 429', async () => {
      await crearItem({
        title: 'Llegada de flores',
        startsAt: '2027-06-12T18:00:00Z',
        eventVendorIds: [contratacionA1],
      })
      const socketA = await conectarComo('provA')
      const enVivo = esperar(
        socketA,
        'notification.created',
        esDeTipo('schedule.confirmation.requested'),
      )

      const r = await request(server)
        .post(`${base()}/notify-vendors`)
        .set(como('creador'))
        .expect(200)
      expect(r.body).toEqual({ notified: 1 })
      expect(await enVivo).toEqual({ eventId, type: 'schedule.confirmation.requested' })
      const avisos = await campana('provA', 'schedule.confirmation.requested')
      expect(avisos).toHaveLength(1)
      expect(avisos[0]?.payload).toEqual({})
      expect(await campana('provB', 'schedule.confirmation.requested')).toEqual([])

      for (let i = 2; i <= 5; i++) {
        await request(server).post(`${base()}/notify-vendors`).set(como('creador')).expect(200)
      }
      await request(server).post(`${base()}/notify-vendors`).set(como('creador')).expect(429)
    })
  })

  describe('recordatorio 15 minutos antes (spec 2026-11-10 §5)', () => {
    it('A lo recibe por socket y en la campana; el ítem del que se le desasignó no avisa', async () => {
      const socketA = await conectarComo('provA')
      const recibidos: unknown[] = []
      socketA.on('notification.created', (d: unknown) => {
        if (esDeTipo('schedule.item.reminder')(d)) recibidos.push(d)
      })
      const primero = esperar(socketA, 'notification.created', esDeTipo('schedule.item.reminder'))

      const startsAt = dentroDe(3)
      const avisa = await crearItem({
        title: 'Entrada del DJ',
        startsAt,
        eventVendorIds: [contratacionA1],
      })
      const desasignado = await crearItem({
        title: 'Ya no es de A',
        startsAt,
        eventVendorIds: [contratacionA1],
      })
      await asignar(desasignado.id, [])

      expect(await primero).toEqual({ eventId, type: 'schedule.item.reminder' })
      const hora = new Date(avisa.startsAt)
      await jobTerminado(jobIdDeRecordatorio(avisa.id, contratacionA1, hora))
      await jobTerminado(jobIdDeRecordatorio(desasignado.id, contratacionA1, hora))

      const avisos = await campana('provA', 'schedule.item.reminder')
      expect(avisos.map((a) => a.payload)).toEqual([
        { scheduleItemId: avisa.id, title: 'Entrada del DJ', startsAt: avisa.startsAt },
      ])
      expect(recibidos).toHaveLength(1)
      expect(await campana('provB', 'schedule.item.reminder')).toEqual([])
    }, 30_000)
  })

  describe('recontratación (Review Focus 3)', () => {
    it('cancelada sale de Vendors Ready; al volver a BOOKED cuenta y recupera el recordatorio', async () => {
      const item = await crearItem({
        title: 'Montaje floral',
        startsAt: '2027-06-12T17:00:00Z',
        eventVendorIds: [contratacionA1],
      })
      expect(await confirmaciones('creador')).toMatchObject({
        ready: 0,
        total: 1,
        vendors: [{ userId: id.provA, ready: false }],
      })

      await cambiarContratacion(contratacionA1, 'CANCELLED')
      const cancelada = await confirmaciones('creador')
      expect(cancelada).toMatchObject({ ready: 0, total: 0, vendors: [] })
      // A sigue en el evento por A2, pero ya no tiene nada asignado.
      expect(await confirmaciones('provA')).toMatchObject({ total: 0, mine: { pending: [] } })

      // Mientras está cancelada se cambia la hora: no se programa nada para A1
      // (no es vigente). Volver a BOOKED es lo que tiene que reponer el aviso.
      const startsAt = dentroDe(4)
      await request(server)
        .patch(`${base()}/${item.id}`)
        .set(como('creador'))
        .send({ startsAt })
        .expect(200)
      expect(await campana('provA', 'schedule.item.rescheduled')).toEqual([])

      const socketA = await conectarComo('provA')
      const recordatorio = esperar(
        socketA,
        'notification.created',
        esDeTipo('schedule.item.reminder'),
      )
      await cambiarContratacion(contratacionA1, 'BOOKED')
      expect(await confirmaciones('creador')).toMatchObject({
        ready: 0,
        total: 1,
        vendors: [{ userId: id.provA, ready: false }],
      })

      expect(await recordatorio).toEqual({ eventId, type: 'schedule.item.reminder' })
      const avisos = await campana('provA', 'schedule.item.reminder')
      expect(avisos.map((a) => a.payload)).toEqual([
        {
          scheduleItemId: item.id,
          title: 'Montaje floral',
          startsAt: new Date(startsAt).toISOString(),
        },
      ])
      // A2 nunca estuvo asignada: sigue sin contar.
      expect(contratacionA2).not.toBe(contratacionA1)
    }, 30_000)
  })
})
