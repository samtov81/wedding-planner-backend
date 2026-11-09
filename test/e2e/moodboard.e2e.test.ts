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

interface ImagenCuerpo {
  id: string
  title: string
  url: string | null
  width: number
  height: number
  category: { id: string; slug: string; name: string }
  uploadedBy: { id: string; name: string }
  createdAt: string
  archivedAt: string | null
  noteCount: number
  sharedWith?: Array<{ eventVendorId: string; name: string }>
}

interface NotaCuerpo {
  id: string
  imageId: string
  body: string
  author: { id: string; name: string; avatarUrl: string | null }
}

interface ResumenCuerpo {
  stats: { images: number; notes: number }
  activity: Array<{ kind: string; imageId: string }>
  collaborators: Array<{ userId: string; role: string; label: string; online: boolean }>
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
 * Los seis perfiles de la matriz de la spec 2026-11-09 §6. "Proveedor con
 * foto" es A (la foto de la matriz se comparte con su primera contratación);
 * "sin foto" es B, contratado (BOOKED) pero sin nada compartido.
 */
const PERFILES = [
  ['creador', 'creador'],
  ['pareja no creadora', 'pareja'],
  ['planner no creador', 'planner'],
  ['proveedor con foto compartida', 'provA'],
  ['proveedor sin foto compartida', 'provB'],
  ['extraño', 'extrano'],
] as const satisfies ReadonlyArray<readonly [string, Actor]>

type Perfil = (typeof PERFILES)[number][1]

const NOMBRE_DE_PERFIL = new Map<Perfil, string>(
  PERFILES.map(([nombre, perfil]) => [perfil, nombre]),
)

type Metodo = 'get' | 'post' | 'patch' | 'put'

/** Lo que una ruta de la matriz necesita para construir su petición. */
interface Contexto {
  eventId: string
  fotoId: string
  categoryId: string
  contratacionA1: string
  /** Una key ya "subida" al almacén falso, válida para `POST /images`. */
  keySubida: string
}

interface Esperado {
  status: number
  /** Comprobación extra del cuerpo, cuando el código solo no basta. */
  cuerpo?: (cuerpo: unknown, ctx: Contexto) => void
}

/** "M" del contrato: miembros sí, proveedores 403, fuera del evento 404. */
function soloMiembros(ok: number): Record<Perfil, Esperado> {
  return {
    creador: { status: ok },
    pareja: { status: ok },
    planner: { status: ok },
    provA: { status: 403 },
    provB: { status: 403 },
    extrano: { status: 404 },
  }
}

const noEncontrada: Esperado = {
  status: 404,
  cuerpo: (c) => expect((c as ErrorCuerpo).code).toBe('MOODBOARD_IMAGE_NOT_FOUND'),
}

/**
 * "T" sobre UNA foto: miembros y el proveedor con quien se compartió la ven;
 * el proveedor sin compartir recibe 404 `MOODBOARD_IMAGE_NOT_FOUND` (no se
 * revela que existe, spec §4); el extraño, 404 del guard.
 */
function sobreLaFoto(ok: number): Record<Perfil, Esperado> {
  return {
    creador: { status: ok },
    pareja: { status: ok },
    planner: { status: ok },
    provA: { status: ok },
    provB: noEncontrada,
    extrano: { status: 404 },
  }
}

const listaConLaFoto: Esperado = {
  status: 200,
  cuerpo: (c, ctx) => expect((c as ImagenCuerpo[]).map((i) => i.id)).toEqual([ctx.fotoId]),
}

const RUTAS: ReadonlyArray<
  readonly [string, (ctx: Contexto) => [Metodo, string, object?], Record<Perfil, Esperado>]
> = [
  [
    'POST /upload-url',
    (ctx) => [
      'post',
      `/events/${ctx.eventId}/moodboard/upload-url`,
      { contentType: 'image/jpeg', bytes: 2048 },
    ],
    soloMiembros(201),
  ],
  [
    'POST /images',
    (ctx) => [
      'post',
      `/events/${ctx.eventId}/moodboard/images`,
      { key: ctx.keySubida, title: 'Nueva', categoryId: ctx.categoryId, width: 800, height: 600 },
    ],
    soloMiembros(201),
  ],
  [
    'GET /images',
    (ctx) => ['get', `/events/${ctx.eventId}/moodboard/images`],
    {
      creador: listaConLaFoto,
      pareja: listaConLaFoto,
      planner: listaConLaFoto,
      provA: listaConLaFoto,
      provB: { status: 200, cuerpo: (c) => expect(c).toEqual([]) },
      extrano: { status: 404 },
    },
  ],
  [
    'GET /images/:imageId',
    (ctx) => ['get', `/events/${ctx.eventId}/moodboard/images/${ctx.fotoId}`],
    sobreLaFoto(200),
  ],
  [
    'PATCH /images/:imageId',
    (ctx) => [
      'patch',
      `/events/${ctx.eventId}/moodboard/images/${ctx.fotoId}`,
      { archived: false },
    ],
    soloMiembros(200),
  ],
  [
    'PUT /images/:imageId/shares',
    (ctx) => [
      'put',
      `/events/${ctx.eventId}/moodboard/images/${ctx.fotoId}/shares`,
      { eventVendorIds: [ctx.contratacionA1] },
    ],
    soloMiembros(200),
  ],
  [
    'GET /shareable-vendors',
    (ctx) => ['get', `/events/${ctx.eventId}/moodboard/shareable-vendors`],
    soloMiembros(200),
  ],
  [
    'GET /images/:imageId/notes',
    (ctx) => ['get', `/events/${ctx.eventId}/moodboard/images/${ctx.fotoId}/notes`],
    sobreLaFoto(200),
  ],
  [
    'POST /images/:imageId/notes',
    (ctx) => [
      'post',
      `/events/${ctx.eventId}/moodboard/images/${ctx.fotoId}/notes`,
      { body: 'Me encanta' },
    ],
    sobreLaFoto(201),
  ],
  [
    'GET /summary',
    (ctx) => ['get', `/events/${ctx.eventId}/moodboard/summary`],
    {
      creador: { status: 200 },
      pareja: { status: 200 },
      planner: { status: 200 },
      provA: { status: 200 },
      provB: { status: 200 },
      extrano: { status: 404 },
    },
  ],
]

/** Producto cartesiano rutas × perfiles para `it.each`. */
const CASOS = RUTAS.flatMap(([ruta, peticion, esperados]) =>
  (Object.entries(esperados) as Array<[Perfil, Esperado]>).map(([perfil, esperado]) => ({
    ruta,
    nombre: NOMBRE_DE_PERFIL.get(perfil),
    perfil,
    peticion,
    esperado,
  })),
)

/**
 * El moodboard entero a través de la app real (HTTP + Socket.IO + BullMQ +
 * Postgres + Redis). La app se construye como en `main.ts` (`configurarApp`
 * con las mismas opciones de fábrica) salvo UN provider: `OBJECT_STORAGE`
 * pasa a `ObjectStorageEnMemoria`, el doble público de `storage`. Sin R2 en
 * el entorno de test, `POST /images` sería siempre 503 y la matriz no podría
 * probar el 201 de un miembro. Alternativa descartada: sembrar las fotos con
 * Prisma, que dejaría sin probar `upload-url` → subida → `POST /images`.
 */
describe('moodboard e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let app: NestExpressApplication
  let server: Server
  let url: string
  let prisma: PrismaClient
  const almacen = new ObjectStorageEnMemoria()
  const abiertos: SocketCliente[] = []

  let eventId: string
  let eventoAjenoId: string
  let categoryId: string
  const tokens = new Map<Actor, string>()
  let id: Record<Actor, string>
  /** A contratado dos veces: Decor & Floral (A1) y Venue (A2). */
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
  const base = () => `/events/${eventId}/moodboard`

  /** Prepara la subida, "sube" al almacén falso y devuelve la key. */
  async function keySubida(eventoId = eventId): Promise<string> {
    const r = await request(server)
      .post(`/events/${eventoId}/moodboard/upload-url`)
      .set(como('creador'))
      .send({ contentType: 'image/jpeg', bytes: 2048 })
      .expect(201)
    const { key } = r.body as { key: string }
    almacen.simularSubida(key, 'image/jpeg', 2048)
    return key
  }

  async function subirFoto(title = 'Centro de mesa', quien: Actor = 'creador') {
    const r = await request(server)
      .post(`${base()}/images`)
      .set(como(quien))
      .send({ key: await keySubida(), title, categoryId, width: 800, height: 600 })
      .expect(201)
    return r.body as ImagenCuerpo
  }

  async function compartir(fotoId: string, eventVendorIds: string[]): Promise<ImagenCuerpo> {
    const r = await request(server)
      .put(`${base()}/images/${fotoId}/shares`)
      .set(como('creador'))
      .send({ eventVendorIds })
      .expect(200)
    return r.body as ImagenCuerpo
  }

  async function archivar(fotoId: string, archived: boolean): Promise<void> {
    await request(server)
      .patch(`${base()}/images/${fotoId}`)
      .set(como('pareja'))
      .send({ archived })
      .expect(200)
  }

  async function nota(fotoId: string, quien: Actor, body: string): Promise<NotaCuerpo> {
    const r = await request(server)
      .post(`${base()}/images/${fotoId}/notes`)
      .set(como(quien))
      .send({ body })
      .expect(201)
    return r.body as NotaCuerpo
  }

  async function campana(quien: Actor): Promise<CampanaCuerpo['items']> {
    const r = await request(server).get('/me/notifications').set(como(quien)).expect(200)
    return (r.body as CampanaCuerpo).items
  }

  async function resumen(quien: Actor): Promise<ResumenCuerpo> {
    const r = await request(server).get(`${base()}/summary`).set(como(quien)).expect(200)
    return r.body as ResumenCuerpo
  }

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
    const unido = (await socket.timeout(5_000).emitWithAck('join', { eventId })) as unknown
    expect(unido).toEqual({ ok: true })
    return socket
  }

  /** El primer `evento` cuyo payload cumple `filtro`, o falla a los `ms`. */
  function esperar(
    socket: SocketCliente,
    evento: string,
    filtro: (datos: unknown) => boolean = () => true,
    ms = 10_000,
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

  /**
   * Todo lo que recibe un socket salvo `presence.changed`, que un proveedor
   * oye legítimamente (spec 2026-11-09 §8) y no es determinista entre casos.
   */
  function grabar(socket: SocketCliente): Array<[string, unknown]> {
    const recibidos: Array<[string, unknown]> = []
    socket.onAny((evento: string, datos: unknown) => {
      if (evento !== 'presence.changed') recibidos.push([evento, datos])
    })
    return recibidos
  }

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
    }
  }

  /** Espera ACOTADA para afirmar que algo NO llega. */
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
    const crear = async (actor: Actor, nombre: string) => {
      const u = await prisma.user.create({
        data: {
          email: `${actor}@moodboard.test`,
          passwordHash: 'x',
          fullName: nombre,
          ...(actor === 'admin' ? { systemRole: 'ADMIN' as const } : {}),
        },
      })
      return { id: u.id, token: firmador.firmarAccess({ id: u.id, systemRole: u.systemRole }) }
    }
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
      nombres.map(async ([actor, nombre]) => [actor, await crear(actor, nombre)] as const),
    )
    id = Object.fromEntries(creados.map(([actor, u]) => [actor, u.id])) as Record<Actor, string>
    for (const [actor, u] of creados) tokens.set(actor, u.token)

    const weddingDate = new Date(Date.now() + 180 * 86_400_000)
    eventId = (
      await prisma.event.create({
        data: { name: 'Boda moodboard', weddingDate, ownerId: id.creador, status: 'ACTIVE' },
      })
    ).id
    eventoAjenoId = (
      await prisma.event.create({
        data: { name: 'Evento ajeno', weddingDate, ownerId: id.extrano, status: 'ACTIVE' },
      })
    ).id
    await prisma.eventMembership.createMany({
      data: [
        { eventId, userId: id.creador, role: 'PLANNER' },
        { eventId, userId: id.pareja, role: 'COUPLE' },
        { eventId, userId: id.planner, role: 'PLANNER' },
        { eventId: eventoAjenoId, userId: id.extrano, role: 'COUPLE' },
      ],
    })

    const decor = await categoriaId(prisma, 'decor-floral')
    const venue = await categoriaId(prisma, 'venue')
    const foto = await categoriaId(prisma, 'photography')
    categoryId = decor
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
    const fichaA = await ficha(id.provA, 'Flores y Lugar A', decor)
    contratacionA1 = await contratar(fichaA, decor, 'BOOKED')
    contratacionA2 = await contratar(fichaA, venue, 'BOOKED')
    contratacionB = await contratar(await ficha(id.provB, 'Fotos B', foto), foto, 'BOOKED')
    contratacionC = await contratar(await ficha(id.provC, 'Velas C', decor), decor, 'SHORTLISTED')
  }, 240_000)

  /**
   * Cada caso parte de un tablero vacío y una campana vacía: las afirmaciones
   * de "lista []" o "2 avisos" no dependen del orden de los casos.
   */
  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
    await prisma.moodboardNote.deleteMany()
    await prisma.moodboardShare.deleteMany()
    await prisma.moodboardImage.deleteMany()
    await prisma.notification.deleteMany()
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

  describe('matriz de acceso (spec 2026-11-09 §4)', () => {
    let ctx: Contexto

    beforeEach(async () => {
      const foto = await subirFoto('Foto de la matriz')
      await compartir(foto.id, [contratacionA1])
      ctx = { eventId, fotoId: foto.id, categoryId, contratacionA1, keySubida: await keySubida() }
    })

    it.each(CASOS)('$ruta como $nombre → $esperado.status', async (caso) => {
      const [metodo, ruta, cuerpo] = caso.peticion(ctx)
      const peticion = abrirPeticion(metodo, ruta).set(como(caso.perfil))
      const r = await (cuerpo === undefined ? peticion : peticion.send(cuerpo))
      expect(r.status).toBe(caso.esperado.status)
      caso.esperado.cuerpo?.(r.body, ctx)
    })

    it('un admin no miembro se comporta como miembro', async () => {
      const r = await request(server).get(`${base()}/images`).set(como('admin')).expect(200)
      const [foto] = r.body as ImagenCuerpo[]
      expect(foto?.id).toBe(ctx.fotoId)
      expect(foto?.sharedWith).toEqual([
        { eventVendorId: contratacionA1, name: 'Flores y Lugar A' },
      ])
    })

    it('sin token, 401', async () => {
      await request(server).get(`${base()}/images`).expect(401)
    })
  })

  describe('proveedor contratado dos veces', () => {
    it('ve las fotos compartidas con cualquiera de sus contrataciones, en lista, detalle, notas y resumen', async () => {
      const f1 = await subirFoto('Por Decor & Floral')
      const f2 = await subirFoto('Por Venue')
      const f3 = await subirFoto('Sin compartir')
      await compartir(f1.id, [contratacionA1])
      await compartir(f2.id, [contratacionA2])
      await nota(f2.id, 'pareja', 'Esta para la entrada')

      const lista = (await request(server).get(`${base()}/images`).set(como('provA')).expect(200))
        .body as ImagenCuerpo[]
      expect(lista.map((i) => i.id).sort()).toEqual([f1.id, f2.id].sort())
      expect(lista.map((i) => i.id)).not.toContain(f3.id)

      for (const f of [f1, f2]) {
        await request(server).get(`${base()}/images/${f.id}`).set(como('provA')).expect(200)
        await request(server).get(`${base()}/images/${f.id}/notes`).set(como('provA')).expect(200)
      }
      const notas = (
        await request(server).get(`${base()}/images/${f2.id}/notes`).set(como('provA')).expect(200)
      ).body as NotaCuerpo[]
      expect(notas.map((n) => n.body)).toEqual(['Esta para la entrada'])

      expect((await resumen('provA')).stats).toEqual({ images: 2, notes: 1 })
      expect((await resumen('creador')).stats).toEqual({ images: 3, notes: 1 })
    })

    it('no recibe sharedWith (ni en lista ni en detalle); un miembro sí', async () => {
      const f = await subirFoto()
      await compartir(f.id, [contratacionA1, contratacionB])

      const lista = (await request(server).get(`${base()}/images`).set(como('provA')).expect(200))
        .body as ImagenCuerpo[]
      expect(lista[0]).not.toHaveProperty('sharedWith')
      const detalle = (
        await request(server).get(`${base()}/images/${f.id}`).set(como('provA')).expect(200)
      ).body as ImagenCuerpo
      expect(detalle).not.toHaveProperty('sharedWith')

      const delMiembro = (
        await request(server).get(`${base()}/images/${f.id}`).set(como('planner')).expect(200)
      ).body as ImagenCuerpo
      expect(
        [...(delMiembro.sharedWith ?? [])].sort((a, b) =>
          a.eventVendorId.localeCompare(b.eventVendorId),
        ),
      ).toEqual(
        [
          { eventVendorId: contratacionA1, name: 'Flores y Lugar A' },
          { eventVendorId: contratacionB, name: 'Fotos B' },
        ].sort((a, b) => a.eventVendorId.localeCompare(b.eventVendorId)),
      )
    })

    it('?archived=true es 403 para un proveedor y 200 para un miembro', async () => {
      const r = await request(server)
        .get(`${base()}/images?archived=true`)
        .set(como('provA'))
        .expect(403)
      expect((r.body as ErrorCuerpo).code).toBe('FORBIDDEN')
      await request(server).get(`${base()}/images?archived=true`).set(como('pareja')).expect(200)
    })
  })

  describe('compartir', () => {
    it('con una contratación SHORTLISTED → 422 MOODBOARD_VENDOR_NOT_SHAREABLE con los ids', async () => {
      const f = await subirFoto()
      const r = await request(server)
        .put(`${base()}/images/${f.id}/shares`)
        .set(como('creador'))
        .send({ eventVendorIds: [contratacionA1, contratacionC] })
        .expect(422)
      expect(r.body).toMatchObject({
        code: 'MOODBOARD_VENDOR_NOT_SHAREABLE',
        details: { eventVendorIds: [contratacionC] },
      })
      // Nada se aplica parcialmente: A sigue sin verla.
      await request(server).get(`${base()}/images/${f.id}`).set(como('provA')).expect(404)
    })

    it('shareable-vendors lista cada contratación BOOKED con exactamente {eventVendorId, name, categoryName}', async () => {
      const r = await request(server)
        .get(`${base()}/shareable-vendors`)
        .set(como('pareja'))
        .expect(200)
      const porId = (a: { eventVendorId: string }, b: { eventVendorId: string }) =>
        a.eventVendorId.localeCompare(b.eventVendorId)
      expect([...(r.body as Array<{ eventVendorId: string }>)].sort(porId)).toStrictEqual(
        [
          {
            eventVendorId: contratacionA1,
            name: 'Flores y Lugar A',
            categoryName: 'Decor & Floral',
          },
          { eventVendorId: contratacionA2, name: 'Flores y Lugar A', categoryName: 'Venue' },
          { eventVendorId: contratacionB, name: 'Fotos B', categoryName: 'Photography' },
        ].sort(porId),
      )
    })

    it('revocar oculta foto y notas; re-compartir las devuelve y vuelve a sonar la campana', async () => {
      const f = await subirFoto()
      await compartir(f.id, [contratacionA1])
      const antigua = await nota(f.id, 'provA', 'Puedo hacerlo en peonías')

      await compartir(f.id, [])
      const r = await request(server).get(`${base()}/images/${f.id}`).set(como('provA')).expect(404)
      expect((r.body as ErrorCuerpo).code).toBe('MOODBOARD_IMAGE_NOT_FOUND')
      await request(server).get(`${base()}/images/${f.id}/notes`).set(como('provA')).expect(404)
      const lista = (await request(server).get(`${base()}/images`).set(como('provA')).expect(200))
        .body as ImagenCuerpo[]
      expect(lista).toEqual([])

      await compartir(f.id, [contratacionA1])
      const notas = (
        await request(server).get(`${base()}/images/${f.id}/notes`).set(como('provA')).expect(200)
      ).body as NotaCuerpo[]
      expect(notas.map((n) => n.id)).toEqual([antigua.id])

      const avisos = (await campana('provA')).filter((n) => n.type === 'moodboard.image.shared')
      expect(avisos).toHaveLength(2)
      for (const a of avisos) {
        expect(a.payload).toEqual({ imageId: f.id })
        expect(a.event.id).toBe(eventId)
      }
    })
  })

  describe('notas', () => {
    it('la nota de B en una foto compartida con A y B: A la lee con autor B y recibe la campana; B no', async () => {
      const f = await subirFoto()
      await compartir(f.id, [contratacionA1, contratacionB])
      const deB = await nota(f.id, 'provB', 'Luz cálida para las fotos')

      const notas = (
        await request(server).get(`${base()}/images/${f.id}/notes`).set(como('provA')).expect(200)
      ).body as NotaCuerpo[]
      expect(notas).toHaveLength(1)
      expect(notas[0]).toMatchObject({
        id: deB.id,
        imageId: f.id,
        body: 'Luz cálida para las fotos',
        author: { id: id.provB, name: 'Proveedor B', avatarUrl: null },
      })

      const deA = (await campana('provA')).filter((n) => n.type === 'moodboard.note.added')
      expect(deA.map((n) => n.payload)).toEqual([{ imageId: f.id, noteId: deB.id }])
      const deLaB = (await campana('provB')).filter((n) => n.type === 'moodboard.note.added')
      expect(deLaB).toEqual([])
      // Quien subió la foto es participante: también la recibe.
      const delCreador = (await campana('creador')).filter((n) => n.type === 'moodboard.note.added')
      expect(delCreador).toHaveLength(1)
    })
  })

  describe('archivar', () => {
    it('los proveedores dejan de verla, no admite notas (422) y al recuperarla vuelve', async () => {
      const f = await subirFoto()
      await compartir(f.id, [contratacionA1, contratacionB])
      await archivar(f.id, true)

      for (const prov of ['provA', 'provB'] as const) {
        await request(server).get(`${base()}/images/${f.id}`).set(como(prov)).expect(404)
        await request(server).get(`${base()}/images/${f.id}/notes`).set(como(prov)).expect(404)
        const r = await request(server)
          .post(`${base()}/images/${f.id}/notes`)
          .set(como(prov))
          .send({ body: 'hola' })
          .expect(404)
        expect((r.body as ErrorCuerpo).code).toBe('MOODBOARD_IMAGE_NOT_FOUND')
        const lista = (await request(server).get(`${base()}/images`).set(como(prov)).expect(200))
          .body as ImagenCuerpo[]
        expect(lista).toEqual([])
      }

      const r = await request(server)
        .post(`${base()}/images/${f.id}/notes`)
        .set(como('planner'))
        .send({ body: 'hola' })
        .expect(422)
      expect((r.body as ErrorCuerpo).code).toBe('MOODBOARD_IMAGE_ARCHIVED')
      const archivadas = (
        await request(server).get(`${base()}/images?archived=true`).set(como('planner')).expect(200)
      ).body as ImagenCuerpo[]
      expect(archivadas.map((i) => i.id)).toEqual([f.id])
      expect(archivadas[0]?.archivedAt).not.toBeNull()

      await archivar(f.id, false)
      await request(server).get(`${base()}/images/${f.id}`).set(como('provA')).expect(200)
      await nota(f.id, 'provA', 'De vuelta')
    })
  })

  describe('validación HTTP', () => {
    it('width 0 o height 20001 → 400', async () => {
      for (const dims of [
        { width: 0, height: 600 },
        { width: 800, height: 20001 },
      ]) {
        await request(server)
          .post(`${base()}/images`)
          .set(como('creador'))
          .send({ key: await keySubida(), title: 'x', categoryId, ...dims })
          .expect(400)
      }
    })

    it('un :imageId que no es UUID → 404 MOODBOARD_IMAGE_NOT_FOUND', async () => {
      for (const peticion of [
        request(server).get(`${base()}/images/no-es-uuid`),
        request(server).get(`${base()}/images/no-es-uuid/notes`),
        request(server).patch(`${base()}/images/no-es-uuid`).send({ archived: true }),
      ]) {
        const r = await peticion.set(como('creador')).expect(404)
        expect((r.body as ErrorCuerpo).code).toBe('MOODBOARD_IMAGE_NOT_FOUND')
      }
    })

    it('una foto de otro evento es 404 desde este', async () => {
      const f = await subirFoto()
      await request(server)
        .get(`/events/${eventoAjenoId}/moodboard/images/${f.id}`)
        .set(como('extrano'))
        .expect(404)
    })
  })

  describe('tiempo real', () => {
    it('compartir con A le manda image.changed y notification.created; revocar, image.hidden', async () => {
      const f = await subirFoto()
      const socketA = await conectarComo('provA')
      const cambio = esperar(
        socketA,
        'moodboard.image.changed',
        (d) => (d as { imageId?: string }).imageId === f.id,
      )
      const aviso = esperar(socketA, 'notification.created')

      await compartir(f.id, [contratacionA1])
      expect(await cambio).toEqual({ eventId, imageId: f.id })
      expect(await aviso).toEqual({ eventId, type: 'moodboard.image.shared' })

      const oculta = esperar(socketA, 'moodboard.image.hidden')
      await compartir(f.id, [])
      expect(await oculta).toEqual({ eventId, imageId: f.id })
    })

    it('B no recibe nada de una foto que no se comparte con él (espera acotada)', async () => {
      const socketA = await conectarComo('provA')
      const socketB = await conectarComo('provB')
      const deB = grabar(socketB)

      const f = await subirFoto()
      const llegaA = esperar(
        socketA,
        'moodboard.image.changed',
        (d) => (d as { imageId?: string }).imageId === f.id,
      )
      await compartir(f.id, [contratacionA1])
      await nota(f.id, 'provA', 'Para A y los miembros')
      await llegaA
      await pausa(1_500)
      expect(deB).toEqual([])

      // Control positivo: el socket de B sí oye lo que se comparte con él.
      const llegaB = esperar(
        socketB,
        'moodboard.image.changed',
        (d) => (d as { imageId?: string }).imageId === f.id,
      )
      await compartir(f.id, [contratacionA1, contratacionB])
      expect(await llegaB).toEqual({ eventId, imageId: f.id })
    })
  })

  describe('resumen', () => {
    it('un miembro ve a A una vez con las dos categorías; A no ve a B; online según el socket', async () => {
      const f1 = await subirFoto()
      const f2 = await subirFoto()
      await compartir(f1.id, [contratacionA1, contratacionB])
      await compartir(f2.id, [contratacionA2])
      await conectarComo('provA')

      // La presencia se registra al conectar; se reintenta un instante por si
      // el registro aún no se confirmó en Redis cuando llega la petición.
      let deMiembro = await resumen('creador')
      for (let i = 0; i < 20; i += 1) {
        if (deMiembro.collaborators.find((c) => c.userId === id.provA)?.online === true) break
        await pausa(100)
        deMiembro = await resumen('creador')
      }
      const aes = deMiembro.collaborators.filter((c) => c.userId === id.provA)
      expect(aes).toEqual([
        expect.objectContaining({
          role: 'VENDOR',
          label: 'Decor & Floral · Venue',
          online: true,
        }),
      ])
      // La pareja nunca abrió un socket en este fichero.
      expect(deMiembro.collaborators.find((c) => c.userId === id.pareja)).toMatchObject({
        role: 'COUPLE',
        online: false,
      })

      const deA = await resumen('provA')
      expect(deA.collaborators.map((c) => c.userId)).not.toContain(id.provB)
      expect(deA.collaborators.filter((c) => c.userId === id.provA)).toHaveLength(1)
    })
  })
})
