import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import type { CursorValue } from '@/shared/domain'

import { categoriaId } from '../../../../test/support/categorias'
import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import {
  AutocontactoError,
  EsperaTrasRechazoError,
  ParNoPermitidoError,
  SolicitudPendienteError,
} from '../domain/messaging-errors'
import { ESPERA_TRAS_RECHAZO_MS } from '../domain/perfil'
import type {
  ConversacionDePerfilVista,
  ConversacionVista,
  ConversationRepository,
  FichaParaContacto,
  SalaVista,
} from '../application/conversation.repository'
import { ConversationRepositoryEnMemoria } from './conversation.repository.fake'
import { PrismaConversationRepository } from './prisma-conversation.repository'

/**
 * Ruling H1: el doble no puede ser más permisivo que Prisma. Cada caso se
 * escribe UNA vez y corre contra los dos con el MISMO escenario (mismos
 * usuarios, mismos eventos, mismos instantes); se comparan las respuestas del
 * puerto sin ids ni instantes de lo que cada uno genera (`sinVolatiles`).
 */
const BASE = new Date('2026-03-01T00:00:00.000Z')
const minuto = (n: number): Date => new Date(BASE.getTime() + n * 60_000)

/** El mismo recurso en las dos implementaciones: cada una genera sus ids. */
interface Par {
  real: string
  doble: string
}

describe('Paridad: ConversationRepositoryEnMemoria vs PrismaConversationRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let real: PrismaConversationRepository
  let doble: ConversationRepositoryEnMemoria
  let parejaId: string
  let plannerId: string
  let invitadoId: string
  let proveedorId: string
  let otroProveedorId: string
  let numEvento = 0

  const implementaciones = (): Array<['real' | 'doble', ConversationRepository]> => [
    ['real', real],
    ['doble', doble],
  ]

  async function crearUsuario(email: string, fullName: string): Promise<string> {
    return (await prisma.user.create({ data: { email, passwordHash: 'x', fullName } })).id
  }

  /** Evento nuevo en los dos; publicado = `ACTIVE` (y entonces lleva fecha). */
  async function nuevoEvento(publicado: boolean): Promise<string> {
    numEvento += 1
    const name = `Boda ${numEvento}`
    const evento = await prisma.event.create({
      data: {
        name,
        ownerId: parejaId,
        status: publicado ? 'ACTIVE' : 'DRAFT',
        weddingDate: publicado ? new Date('2027-06-12T00:00:00.000Z') : null,
      },
    })
    doble.registrarEvento(evento.id, name)
    doble.fijarPublicado(evento.id, publicado)
    return evento.id
  }

  const nombres = new Map<string, string>()
  /** Fichas por `userId`; el doble se siembra con el MISMO id que Postgres. */
  const fichas = new Map<string, FichaParaContacto>()

  async function miembro(
    eventId: string,
    userId: string,
    role: 'COUPLE' | 'PLANNER',
    status: 'ACTIVE' | 'INVITED' | 'REVOKED' = 'ACTIVE',
  ): Promise<void> {
    await prisma.eventMembership.upsert({
      where: { eventId_userId: { eventId, userId } },
      create: { eventId, userId, role, status },
      update: { role, status },
    })
    doble.registrarMiembro(eventId, userId, role, status, nombres.get(userId) ?? userId)
  }

  async function proveedor(eventId: string, userId: string, booked: boolean): Promise<void> {
    const perfil = await prisma.vendorProfile.findUniqueOrThrow({ where: { userId } })
    const existente = await prisma.eventVendor.findFirst({
      where: { eventId, vendorProfileId: perfil.id },
    })
    const status = booked ? 'BOOKED' : 'CANCELLED'
    if (existente === null) {
      await prisma.eventVendor.create({
        data: { eventId, vendorProfileId: perfil.id, categoryId: perfil.categoryId, status },
      })
    } else {
      await prisma.eventVendor.update({ where: { id: existente.id }, data: { status } })
    }
    doble.registrarProveedor(eventId, userId, perfil.businessName, booked)
  }

  async function publicar(eventId: string, publicado: boolean): Promise<void> {
    await prisma.event.update({
      where: { id: eventId },
      data: publicado
        ? { status: 'ACTIVE', weddingDate: new Date('2027-06-12T00:00:00.000Z') }
        : { status: 'DRAFT' },
    })
    doble.fijarPublicado(eventId, publicado)
  }

  async function abrirEnAmbos(eventId: string, a: string, b: string): Promise<Par> {
    const r = await real.abrir(eventId, a, b)
    const d = await doble.abrir(eventId, a, b)
    return { real: r.id, doble: d.id }
  }

  async function enviarEnAmbos(
    conv: Par,
    senderId: string,
    body: string,
    min: number,
  ): Promise<Par> {
    const r = await real.agregarMensaje(conv.real, senderId, body, minuto(min))
    const d = await doble.agregarMensaje(conv.doble, senderId, body, minuto(min))
    return { real: r.id, doble: d.id }
  }

  const idDe = (par: Par, quien: 'real' | 'doble'): string =>
    quien === 'real' ? par.real : par.doble

  /** Lo comparable entre las dos: sin ids de conversación/mensaje ni instantes. */
  function sinVolatiles(v: ConversacionVista): unknown {
    return {
      event: v.event,
      other: v.other,
      lastMessage: v.lastMessage === null ? null : { body: v.lastMessage.body },
      unreadCount: v.unreadCount,
      readOnly: v.readOnly,
      otherMarks: {
        deliveredUpTo: v.otherMarks.deliveredUpTo === null,
        readUpTo: v.otherMarks.readUpTo === null,
      },
    }
  }

  const ordenados = <T extends { userId: string }>(xs: T[]): T[] =>
    [...xs].sort((x, y) => (x.userId < y.userId ? -1 : 1))

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    real = new PrismaConversationRepository(prisma as unknown as PrismaService)

    parejaId = await crearUsuario('pareja@paridad.test', 'Pareja')
    plannerId = await crearUsuario('planner@paridad.test', 'Planner')
    invitadoId = await crearUsuario('invitado@paridad.test', 'Invitado')
    proveedorId = await crearUsuario('proveedor@paridad.test', 'Dueño Catering')
    otroProveedorId = await crearUsuario('otro-proveedor@paridad.test', 'Dueño Flores')
    nombres.set(parejaId, 'Pareja')
    nombres.set(plannerId, 'Planner')
    nombres.set(invitadoId, 'Invitado')
    nombres.set(proveedorId, 'Dueño Catering')
    nombres.set(otroProveedorId, 'Dueño Flores')
    for (const [userId, businessName, slug] of [
      [proveedorId, 'Catering Sol', 'catering'],
      [otroProveedorId, 'Flores Luna', 'photography'],
    ] as const) {
      const ficha = await prisma.vendorProfile.create({
        data: { userId, businessName, categoryId: await categoriaId(prisma, slug) },
      })
      fichas.set(userId, { id: ficha.id, userId, businessName, publicada: false })
    }
  }, 240_000)

  beforeEach(async () => {
    await prisma.message.deleteMany()
    await prisma.conversation.deleteMany()
    doble = new ConversationRepositoryEnMemoria()
    for (const [userId, fullName] of nombres) doble.registrarUsuario(userId, fullName)
    for (const f of fichas.values()) {
      doble.sembrarFicha(f.userId, { businessName: f.businessName, publicada: f.publicada }, f.id)
    }
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  it('abrir dos veces el mismo par (en cualquier orden) devuelve la misma conversación', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')

    for (const [, repo] of implementaciones()) {
      const primera = await repo.abrir(eventId, parejaId, plannerId)
      const segunda = await repo.abrir(eventId, plannerId, parejaId)
      expect(primera.creada).toBe(true)
      expect(segunda).toEqual({ id: primera.id, creada: false })
      expect((await repo.participantes(primera.id)).sort()).toEqual([parejaId, plannerId].sort())
    }
  })

  it('contactos de un proveedor: la pareja y los planners ACTIVE, nunca otros proveedores ni INVITED', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    await miembro(eventId, invitadoId, 'PLANNER', 'INVITED')
    await proveedor(eventId, proveedorId, true)
    await proveedor(eventId, otroProveedorId, true)

    const esperado = ordenados([
      { userId: parejaId, displayName: 'Pareja', role: 'COUPLE' },
      { userId: plannerId, displayName: 'Planner', role: 'PLANNER' },
    ])
    for (const [, repo] of implementaciones()) {
      expect(ordenados(await repo.contactos(eventId, proveedorId))).toEqual(esperado)
    }
  })

  it('contactos de un miembro: miembros ACTIVE y proveedores BOOKED de evento publicado', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    await miembro(eventId, invitadoId, 'PLANNER', 'INVITED')
    await proveedor(eventId, proveedorId, true)
    await proveedor(eventId, otroProveedorId, false)

    const esperado = ordenados([
      { userId: plannerId, displayName: 'Planner', role: 'PLANNER' },
      { userId: proveedorId, displayName: 'Catering Sol', role: 'VENDOR' },
    ])
    for (const [, repo] of implementaciones()) {
      expect(ordenados(await repo.contactos(eventId, parejaId))).toEqual(esperado)
    }

    // Sin publicar, los proveedores desaparecen de los contactos del miembro.
    await publicar(eventId, false)
    for (const [, repo] of implementaciones()) {
      expect(await repo.contactos(eventId, parejaId)).toEqual([
        { userId: plannerId, displayName: 'Planner', role: 'PLANNER' },
      ])
    }
  })

  it('rolEnEvento: proveedor de evento sin publicar o cancelado → null; miembro de evento sin publicar → su rol', async () => {
    const borrador = await nuevoEvento(false)
    await miembro(borrador, parejaId, 'COUPLE')
    await proveedor(borrador, proveedorId, true)
    const publicado = await nuevoEvento(true)
    await miembro(publicado, invitadoId, 'PLANNER', 'INVITED')
    await proveedor(publicado, proveedorId, true)
    await proveedor(publicado, otroProveedorId, false)

    for (const [, repo] of implementaciones()) {
      expect(await repo.rolEnEvento(borrador, proveedorId)).toBeNull()
      expect(await repo.rolEnEvento(borrador, parejaId)).toBe('COUPLE')
      expect(await repo.rolEnEvento(publicado, proveedorId)).toBe('VENDOR')
      expect(await repo.rolEnEvento(publicado, otroProveedorId)).toBeNull()
      expect(await repo.rolEnEvento(publicado, invitadoId)).toBeNull()
      expect(await repo.rolEnEvento(publicado, plannerId)).toBeNull()
    }
  })

  it('bandeja: un miembro revocado ve la conversación en solo lectura; un proveedor cancelado no la ve', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    await proveedor(eventId, proveedorId, true)
    const conPlanner = await abrirEnAmbos(eventId, parejaId, plannerId)
    const conProveedor = await abrirEnAmbos(eventId, parejaId, proveedorId)
    await enviarEnAmbos(conPlanner, plannerId, 'hola pareja', 1)
    await enviarEnAmbos(conProveedor, proveedorId, 'hola desde el catering', 2)

    for (const [, repo] of implementaciones()) {
      const antes = await repo.bandeja(parejaId)
      expect(antes.items.map((v) => v.readOnly)).toEqual([false, false])
    }

    await miembro(eventId, plannerId, 'PLANNER', 'REVOKED')
    await proveedor(eventId, proveedorId, false)

    const vistas: Record<string, unknown[]> = {}
    for (const [quien, repo] of implementaciones()) {
      const pareja = await repo.bandeja(parejaId)
      // Quien conserva acceso ve ambas, pero ya sólo se leen.
      expect(pareja.items.map((v) => [v.other.userId, v.readOnly])).toEqual([
        [proveedorId, true],
        [plannerId, true],
      ])
      const planner = await repo.bandeja(plannerId)
      expect(planner.items.map((v) => [v.other.userId, v.readOnly])).toEqual([[parejaId, true]])
      expect((await repo.bandeja(proveedorId)).items).toEqual([])
      expect(await repo.buscar(idDe(conProveedor, quien), proveedorId)).toBeNull()
      expect(await repo.buscar(idDe(conPlanner, quien), plannerId)).not.toBeNull()
      vistas[quien === 'real' ? 'real' : 'doble'] = [...pareja.items, ...planner.items].map(
        sinVolatiles,
      )
    }
    expect(vistas.doble).toEqual(vistas.real)
  })

  it('bandeja: unreadCount cuenta los mensajes del otro posteriores a mi readUpTo; unreadTotal suma también las de solo lectura', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    await proveedor(eventId, proveedorId, true)
    const conPlanner = await abrirEnAmbos(eventId, parejaId, plannerId)
    const conProveedor = await abrirEnAmbos(eventId, parejaId, proveedorId)
    const m1 = await enviarEnAmbos(conPlanner, plannerId, 'uno', 1)
    await enviarEnAmbos(conPlanner, plannerId, 'dos', 2)
    await enviarEnAmbos(conPlanner, plannerId, 'tres', 3)
    await enviarEnAmbos(conPlanner, parejaId, 'mío', 4) // propio: no cuenta
    await enviarEnAmbos(conProveedor, proveedorId, 'cotización', 5)

    const resultados: unknown[] = []
    for (const [quien, repo] of implementaciones()) {
      expect(
        await repo.marcar(idDe(conPlanner, quien), parejaId, 'read', idDe(m1, quien)),
      ).not.toBe(false)
    }
    await proveedor(eventId, proveedorId, false) // pasa a solo lectura, sigue contando

    for (const [quien, repo] of implementaciones()) {
      const { items, unreadTotal } = await repo.bandeja(parejaId)
      const porOtro = new Map(items.map((v) => [v.other.userId, v]))
      expect(porOtro.get(plannerId)?.unreadCount).toBe(2)
      expect(porOtro.get(proveedorId)?.unreadCount).toBe(1)
      expect(porOtro.get(proveedorId)?.readOnly).toBe(true)
      expect(unreadTotal).toBe(3)
      // Orden: la del mensaje más reciente (proveedor, min 5) antes que la del planner (min 4).
      expect(items.map((v) => v.other.userId)).toEqual([proveedorId, plannerId])
      expect(items[1]?.lastMessage?.body).toBe('mío')
      expect(idDe(conPlanner, quien)).toBe(items[1]?.id)
      resultados.push(items.map(sinVolatiles))
    }
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('bandeja: sin mensajes va al final y la marca del otro se ve en otherMarks', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    await proveedor(eventId, proveedorId, true)
    const vacia = await abrirEnAmbos(eventId, parejaId, plannerId)
    const conMensaje = await abrirEnAmbos(eventId, parejaId, proveedorId)
    const m = await enviarEnAmbos(conMensaje, parejaId, 'hola', 1)

    for (const [quien, repo] of implementaciones()) {
      await repo.marcar(idDe(conMensaje, quien), proveedorId, 'delivered', idDe(m, quien))
      const { items } = await repo.bandeja(parejaId)
      expect(items.map((v) => v.id)).toEqual([idDe(conMensaje, quien), idDe(vacia, quien)])
      expect(items[0]?.otherMarks.deliveredUpTo?.id).toBe(idDe(m, quien))
      expect(items[0]?.otherMarks.readUpTo).toBeNull()
    }
  })

  it('mensajes: más recientes primero, páginas de N exactas con createdAt empatados', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    const conv = await abrirEnAmbos(eventId, parejaId, plannerId)
    // Tres mensajes empatados en el mismo instante: sólo el id los desempata.
    for (const [cuerpo, min] of [
      ['a', 1],
      ['b', 2],
      ['c', 2],
      ['d', 2],
      ['e', 3],
    ] as const) {
      await enviarEnAmbos(conv, plannerId, cuerpo, min)
    }

    for (const [quien, repo] of implementaciones()) {
      const todos: Array<{ id: string; createdAt: Date; body: string }> = []
      let desde: CursorValue | null = null
      const tamanos: number[] = []
      for (;;) {
        const pagina = await repo.mensajes(idDe(conv, quien), { desde, limite: 2 })
        tamanos.push(pagina.items.length)
        todos.push(...pagina.items)
        if (pagina.nextCursor === null) break
        const ultimo = pagina.items.at(-1)
        desde = ultimo === undefined ? null : { createdAt: ultimo.createdAt, id: ultimo.id }
      }
      expect(tamanos).toEqual([2, 2, 1])
      expect(new Set(todos.map((x) => x.id)).size).toBe(5)
      expect(todos[0]?.body).toBe('e')
      expect(todos.at(-1)?.body).toBe('a')
      const esperado = [...todos].sort(
        (x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1),
      )
      expect(todos.map((x) => x.id)).toEqual(esperado.map((x) => x.id))
    }
  })

  it('marcar nunca retrocede y rechaza un upTo de otra conversación', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    await proveedor(eventId, proveedorId, true)
    const conv = await abrirEnAmbos(eventId, parejaId, plannerId)
    const ajena = await abrirEnAmbos(eventId, parejaId, proveedorId)
    const m1 = await enviarEnAmbos(conv, plannerId, 'uno', 1)
    const m3 = await enviarEnAmbos(conv, plannerId, 'tres', 3)
    const deAjena = await enviarEnAmbos(ajena, proveedorId, 'ajeno', 2)

    for (const [quien, repo] of implementaciones()) {
      const id = idDe(conv, quien)
      const alto = await repo.marcar(id, parejaId, 'read', idDe(m3, quien))
      expect(alto).not.toBe(false)
      const atras = await repo.marcar(id, parejaId, 'read', idDe(m1, quien))
      if (atras === false) throw new Error('debía aceptar un upTo de la conversación')
      expect(atras.readUpTo?.id).toBe(idDe(m3, quien))
      expect(atras.deliveredUpTo).toBeNull()
      expect(await repo.marcar(id, parejaId, 'read', idDe(deAjena, quien))).toBe(false)
      expect(await repo.marcar(id, parejaId, 'delivered', idDe(deAjena, quien))).toBe(false)
    }
  })

  it('bandeja: con createdAt empatados el id decide qué mensajes quedan tras mi readUpTo', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    const conv = await abrirEnAmbos(eventId, parejaId, plannerId)
    // Cuatro mensajes del planner en el MISMO instante: sólo el id los ordena.
    const ids: Par[] = []
    for (const cuerpo of ['a', 'b', 'c', 'd']) {
      ids.push(await enviarEnAmbos(conv, plannerId, cuerpo, 1))
    }

    for (const [quien, repo] of implementaciones()) {
      const orden = (await repo.mensajes(idDe(conv, quien), { desde: null, limite: 10 })).items
      // `items` va de más reciente a más antiguo por (createdAt, id): el 2º es el tercero.
      const marca = orden[1]
      if (marca === undefined) throw new Error('faltan mensajes')
      await repo.marcar(idDe(conv, quien), parejaId, 'read', marca.id)
      const { items, unreadTotal } = await repo.bandeja(parejaId)
      // Quedan por leer exactamente los dos de id mayor que la marca.
      expect(items[0]?.unreadCount).toBe(1)
      expect(unreadTotal).toBe(1)
    }
    expect(ids).toHaveLength(4)
  })

  it('mensaje: lo devuelve por id y es null si es de otra conversación o no existe', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    const conv = await abrirEnAmbos(eventId, parejaId, plannerId)
    const otra = await abrirEnAmbos(eventId, parejaId, invitadoId)
    const msg = await enviarEnAmbos(conv, parejaId, 'hola', 1)
    const vistos = []
    for (const [quien, repo] of implementaciones()) {
      const m = await repo.mensaje(idDe(conv, quien), idDe(msg, quien))
      vistos.push({ body: m?.body, senderId: m?.senderId, createdAt: m?.createdAt })
      expect(await repo.mensaje(idDe(otra, quien), idDe(msg, quien))).toBeNull()
      expect(await repo.mensaje(idDe(conv, quien), randomUUID())).toBeNull()
    }
    expect(vistos[0]).toEqual(vistos[1])
    expect(vistos[0]).toEqual({ body: 'hola', senderId: parejaId, createdAt: minuto(1) })
  })

  it('abrir consigo mismo se rechaza con un error de dominio', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    for (const [, repo] of implementaciones()) {
      await expect(repo.abrir(eventId, parejaId, parejaId)).rejects.toBeInstanceOf(
        ParNoPermitidoError,
      )
    }
  })

  // ── Sala del evento (parte 2) ──────────────────────────────────────────────

  /** Lo comparable de una sala: sin ids ni instantes; el tope sólo por su cuerpo. */
  function salaSinVolatiles(v: SalaVista | null, cuerpos: Map<string, string>): unknown {
    if (v === null) return null
    return {
      event: v.event,
      memberCount: v.memberCount,
      lastMessage: v.lastMessage === null ? null : { body: v.lastMessage.body },
      unreadCount: v.unreadCount,
      readOnly: v.readOnly,
      visibleHasta: v.visibleHasta === null ? null : cuerpos.get(v.visibleHasta.id),
    }
  }

  /** Abre la sala como `userId` en los dos; null en los dos si no la crea. */
  async function abrirSalaEnAmbos(eventId: string, userId: string): Promise<Par | null> {
    const r = await real.abrirSala(eventId, userId)
    const d = await doble.abrirSala(eventId, userId)
    expect(r === null).toBe(d === null)
    return r === null || d === null ? null : { real: r, doble: d }
  }

  /** Envía en la sala de los dos y devuelve los ids y los destinatarios (iguales). */
  async function enviarEnSala(
    sala: Par,
    senderId: string,
    body: string,
    min: number,
    cuerpos: Map<string, string>,
  ): Promise<Par> {
    const r = await real.agregarMensajeDeSala(sala.real, senderId, body, minuto(min))
    const d = await doble.agregarMensajeDeSala(sala.doble, senderId, body, minuto(min))
    expect([...r.destinatarios].sort()).toEqual([...d.destinatarios].sort())
    cuerpos.set(r.mensaje.id, body)
    cuerpos.set(d.mensaje.id, body)
    return { real: r.mensaje.id, doble: d.mensaje.id }
  }

  async function salaEnAmbos(
    sala: Par,
    userId: string,
    cuerpos: Map<string, string>,
  ): Promise<unknown> {
    const r = salaSinVolatiles(await real.buscarSala(sala.real, userId), cuerpos)
    const d = salaSinVolatiles(await doble.buscarSala(sala.doble, userId), cuerpos)
    expect(r).toEqual(d)
    return r
  }

  it('abrirSala: una sola por evento; un proveedor o alguien sin membresía obtiene null si no existe', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await proveedor(eventId, proveedorId, true)

    expect(await abrirSalaEnAmbos(eventId, proveedorId)).toBeNull()
    expect(await abrirSalaEnAmbos(eventId, invitadoId)).toBeNull()
    const sala = await abrirSalaEnAmbos(eventId, parejaId)
    expect(sala).not.toBeNull()
    for (const [quien, repo] of implementaciones()) {
      const id = sala === null ? '' : idDe(sala, quien)
      expect(await repo.abrirSala(eventId, parejaId)).toBe(id)
      // Ya existe: el proveedor obtiene su id, pero no la ve.
      expect(await repo.abrirSala(eventId, proveedorId)).toBe(id)
      expect(await repo.buscarSala(id, proveedorId)).toBeNull()
      expect(await repo.buscarSala(id, invitadoId)).toBeNull()
      // Una sala no es una conversación 1:1 ni sale en la bandeja.
      expect(await repo.buscar(id, parejaId)).toBeNull()
      expect((await repo.bandeja(parejaId)).items).toEqual([])
    }
  })

  it('agregarMensajeDeSala: destinatarios = ACTIVE sin el remitente; nunca proveedores ni INVITED', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    await miembro(eventId, invitadoId, 'PLANNER', 'INVITED')
    await proveedor(eventId, proveedorId, true)
    const cuerpos = new Map<string, string>()
    const sala = await abrirSalaEnAmbos(eventId, parejaId)
    if (sala === null) throw new Error('sin sala')

    const m = await enviarEnSala(sala, parejaId, 'hola', 1, cuerpos)
    for (const [quien, repo] of implementaciones()) {
      const destinatarios = await repo.destinatariosDe([idDe(m, quien)])
      expect(destinatarios.get(idDe(m, quien))).toEqual([plannerId])
      expect((await repo.participantes(idDe(sala, quien))).sort()).toEqual(
        [parejaId, plannerId].sort(),
      )
    }
    expect(await salaEnAmbos(sala, plannerId, cuerpos)).toEqual({
      event: { id: eventId, name: expect.any(String) as string },
      memberCount: 2,
      lastMessage: { body: 'hola' },
      unreadCount: 1,
      readOnly: false,
      visibleHasta: null,
    })
  })

  it('buscarSala: quien entra tarde ve el historial con 0 no leídos', async () => {
    const eventId = await nuevoEvento(false)
    await miembro(eventId, parejaId, 'COUPLE')
    const cuerpos = new Map<string, string>()
    const sala = await abrirSalaEnAmbos(eventId, parejaId)
    if (sala === null) throw new Error('sin sala')
    await enviarEnSala(sala, parejaId, 'antes', 1, cuerpos)

    await miembro(eventId, plannerId, 'PLANNER')
    expect(await salaEnAmbos(sala, plannerId, cuerpos)).toMatchObject({
      lastMessage: { body: 'antes' },
      unreadCount: 0,
      readOnly: false,
    })
    for (const [quien, repo] of implementaciones()) {
      const pagina = await repo.mensajes(idDe(sala, quien), { desde: null, limite: 10 })
      expect(pagina.items.map((x) => x.body)).toEqual(['antes'])
    }
    await enviarEnSala(sala, parejaId, 'después', 2, cuerpos)
    expect(await salaEnAmbos(sala, plannerId, cuerpos)).toMatchObject({ unreadCount: 1 })
  })

  it('buscarSala: un revocado la ve en solo lectura hasta su último mensaje; null si no recibió ninguno', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    const cuerpos = new Map<string, string>()
    const sala = await abrirSalaEnAmbos(eventId, parejaId)
    if (sala === null) throw new Error('sin sala')
    await enviarEnSala(sala, parejaId, 'uno', 1, cuerpos)
    await enviarEnSala(sala, plannerId, 'dos', 2, cuerpos)

    await miembro(eventId, plannerId, 'PLANNER', 'REVOKED')
    await enviarEnSala(sala, parejaId, 'tres', 3, cuerpos)
    expect(await salaEnAmbos(sala, plannerId, cuerpos)).toEqual({
      event: { id: eventId, name: expect.any(String) as string },
      memberCount: 1,
      lastMessage: { body: 'dos' },
      unreadCount: 1,
      readOnly: true,
      visibleHasta: 'dos',
    })

    // Un INVITED que entró a la sala (participante) sin recibir nada: nada visible.
    await miembro(eventId, invitadoId, 'PLANNER')
    await abrirSalaEnAmbos(eventId, invitadoId)
    await miembro(eventId, invitadoId, 'PLANNER', 'REVOKED')
    expect(await salaEnAmbos(sala, invitadoId, cuerpos)).toMatchObject({
      lastMessage: null,
      unreadCount: 0,
      readOnly: true,
      visibleHasta: null,
    })
  })

  it('buscarSala: un readmitido vuelve a escribir y sin tope', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER', 'REVOKED')
    const cuerpos = new Map<string, string>()
    const sala = await abrirSalaEnAmbos(eventId, parejaId)
    if (sala === null) throw new Error('sin sala')
    await enviarEnSala(sala, parejaId, 'mientras fuera', 1, cuerpos)
    // Nunca participó: revocado sin fila de participante, no la ve.
    expect(await salaEnAmbos(sala, plannerId, cuerpos)).toBeNull()

    await miembro(eventId, plannerId, 'PLANNER')
    expect(await salaEnAmbos(sala, plannerId, cuerpos)).toMatchObject({
      lastMessage: { body: 'mientras fuera' },
      readOnly: false,
      visibleHasta: null,
    })
  })

  it('buscarSala: proveedor y admin sin membresía → null', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await proveedor(eventId, proveedorId, true)
    const cuerpos = new Map<string, string>()
    const sala = await abrirSalaEnAmbos(eventId, parejaId)
    if (sala === null) throw new Error('sin sala')
    await enviarEnSala(sala, parejaId, 'hola', 1, cuerpos)
    expect(await salaEnAmbos(sala, proveedorId, cuerpos)).toBeNull()
    expect(await salaEnAmbos(sala, invitadoId, cuerpos)).toBeNull()
  })

  it('salas: crea la de cada evento ACTIVE, incluye las de solo lectura y suma unreadTotal', async () => {
    // Usuario propio: las membresías de otros casos siguen en Postgres.
    const solo = await crearUsuario('salas@paridad.test', 'Planner Salas')
    nombres.set(solo, 'Planner Salas')
    const activo = await nuevoEvento(true)
    const viejo = await nuevoEvento(true)
    const ajeno = await nuevoEvento(true)
    await miembro(activo, solo, 'PLANNER')
    await miembro(viejo, parejaId, 'COUPLE')
    await miembro(viejo, solo, 'PLANNER')
    await miembro(ajeno, parejaId, 'COUPLE')
    const cuerpos = new Map<string, string>()
    const salaVieja = await abrirSalaEnAmbos(viejo, parejaId)
    if (salaVieja === null) throw new Error('sin sala')
    await enviarEnSala(salaVieja, parejaId, 'adiós', 1, cuerpos)
    await miembro(viejo, solo, 'PLANNER', 'REVOKED')

    const r = await real.salas(solo)
    const d = await doble.salas(solo)
    const comparable = (x: { items: SalaVista[]; unreadTotal: number }): unknown => ({
      items: x.items.map((v) => salaSinVolatiles(v, cuerpos)),
      unreadTotal: x.unreadTotal,
    })
    expect(comparable(r)).toEqual(comparable(d))
    expect(r.unreadTotal).toBe(1)
    expect(r.items.map((v) => [v.event.id, v.readOnly])).toEqual([
      [viejo, true],
      [activo, false],
    ])
    // La de `activo` quedó creada: abrirla otra vez da el mismo id.
    expect(await real.abrirSala(activo, solo)).toBe(r.items[1]?.id)
  })

  it('mensajes con hasta: corta en el tope; con null, vacía', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    const cuerpos = new Map<string, string>()
    const sala = await abrirSalaEnAmbos(eventId, parejaId)
    if (sala === null) throw new Error('sin sala')
    await enviarEnSala(sala, parejaId, 'a', 1, cuerpos)
    const b = await enviarEnSala(sala, parejaId, 'b', 2, cuerpos)
    await enviarEnSala(sala, parejaId, 'c', 3, cuerpos)

    for (const [quien, repo] of implementaciones()) {
      const tope = await repo.mensaje(idDe(sala, quien), idDe(b, quien))
      if (tope === null) throw new Error('sin mensaje')
      const hasta = { at: tope.createdAt, id: tope.id }
      const cortada = await repo.mensajes(idDe(sala, quien), { desde: null, limite: 1, hasta })
      expect(cortada.items.map((x) => x.body)).toEqual(['b'])
      expect(cortada.nextCursor).not.toBeNull()
      const vacia = await repo.mensajes(idDe(sala, quien), { desde: null, limite: 5, hasta: null })
      expect(vacia).toEqual({ items: [], nextCursor: null })
    }
  })

  it('marcasDeSala y destinatariosDe devuelven lo mismo en los dos', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    const cuerpos = new Map<string, string>()
    const sala = await abrirSalaEnAmbos(eventId, parejaId)
    if (sala === null) throw new Error('sin sala')
    const m = await enviarEnSala(sala, parejaId, 'hola', 1, cuerpos)
    await miembro(eventId, invitadoId, 'PLANNER')
    await abrirSalaEnAmbos(eventId, invitadoId)

    const resultados = []
    for (const [quien, repo] of implementaciones()) {
      expect(await repo.marcar(idDe(sala, quien), plannerId, 'read', idDe(m, quien))).not.toBe(
        false,
      )
      expect(await repo.tipoDe(idDe(sala, quien))).toBe('EVENT_ROOM')
      expect(await repo.tipoDe(randomUUID())).toBeNull()
      const marcas = ordenados(await repo.marcasDeSala(idDe(sala, quien)))
      const destinatarios = await repo.destinatariosDe([idDe(m, quien), randomUUID()])
      resultados.push({
        marcas: marcas.map((x) => ({
          userId: x.userId,
          displayName: x.displayName,
          role: x.role,
          deliveredUpTo: x.deliveredUpTo === null,
          readUpTo: x.readUpTo?.id === idDe(m, quien),
        })),
        destinatarios: [...destinatarios.values()],
        claves: destinatarios.size,
      })
    }
    expect(resultados[0]).toEqual(resultados[1])
    expect(resultados[0]).toMatchObject({ destinatarios: [[plannerId]], claves: 1 })
    expect(resultados[0]?.marcas).toHaveLength(3)
  })

  it('miembrosDeSala lista los ACTIVE de hoy, con o sin fila de participante, y devuelve lo mismo en los dos', async () => {
    const eventId = await nuevoEvento(true)
    const revocado = await crearUsuario('revocado@paridad.test', 'Zeta Revocado')
    const invitado = await crearUsuario('invitado2@paridad.test', 'Beta Invitado')
    const tardio = await crearUsuario('tardio@paridad.test', 'Alfa Tardío')
    for (const [id, nombre] of [
      [revocado, 'Zeta Revocado'],
      [invitado, 'Beta Invitado'],
      [tardio, 'Alfa Tardío'],
    ] as const) {
      nombres.set(id, nombre)
    }
    await miembro(eventId, parejaId, 'COUPLE')
    await miembro(eventId, plannerId, 'PLANNER')
    await miembro(eventId, revocado, 'PLANNER')
    await proveedor(eventId, proveedorId, true)
    const cuerpos = new Map<string, string>()
    const sala = await abrirSalaEnAmbos(eventId, parejaId)
    if (sala === null) throw new Error('sin sala')
    // El revocado llega a participar (recibe un mensaje) y luego sale.
    await enviarEnSala(sala, parejaId, 'hola', 1, cuerpos)
    await miembro(eventId, revocado, 'PLANNER', 'REVOKED')
    await miembro(eventId, invitado, 'PLANNER', 'INVITED')
    // ACTIVE desde ahora, pero nunca abrió la sala: no tiene fila de participante.
    await miembro(eventId, tardio, 'PLANNER')

    const esperado = [
      { userId: tardio, displayName: 'Alfa Tardío', role: 'PLANNER' },
      { userId: parejaId, displayName: 'Pareja', role: 'COUPLE' },
      { userId: plannerId, displayName: 'Planner', role: 'PLANNER' },
    ]
    for (const [quien, repo] of implementaciones()) {
      expect(await repo.miembrosDeSala(idDe(sala, quien))).toEqual(esperado)
      expect(await repo.miembrosDeSala(randomUUID())).toEqual([])
    }
    // `marcasDeSala` no sirve para esto: trae al revocado y omite al tardío.
    for (const [quien, repo] of implementaciones()) {
      const ids = (await repo.marcasDeSala(idDe(sala, quien))).map((x) => x.userId)
      expect(ids).toContain(revocado)
      expect(ids).not.toContain(tardio)
    }
  })

  // ── Contacto desde la ficha (parte 3) ──────────────────────────────────────

  const DIA_EN_MIN = ESPERA_TRAS_RECHAZO_MS / 60_000
  let numProveedor = 0

  /** Usuario nuevo con ficha en el estado pedido, sembrada en los dos con el mismo id. */
  async function nuevoProveedor(
    businessName: string,
    status: 'DRAFT' | 'PUBLISHED' | 'SUSPENDED' = 'PUBLISHED',
  ): Promise<FichaParaContacto> {
    numProveedor += 1
    const fullName = `Dueño ${numProveedor}`
    const userId = await crearUsuario(`proveedor-${numProveedor}@perfil.test`, fullName)
    const fila = await prisma.vendorProfile.create({
      data: { userId, businessName, categoryId: await categoriaId(prisma), status },
    })
    const ficha = { id: fila.id, userId, businessName, publicada: status === 'PUBLISHED' }
    nombres.set(userId, fullName)
    fichas.set(userId, ficha)
    doble.registrarUsuario(userId, fullName)
    doble.sembrarFicha(userId, { businessName, publicada: ficha.publicada }, ficha.id)
    return ficha
  }

  function fichaDe(userId: string): FichaParaContacto {
    const ficha = fichas.get(userId)
    if (ficha === undefined) throw new Error(`sin ficha para ${userId}`)
    return ficha
  }

  async function solicitarEnAmbos(
    solicitante: string,
    dueno: string,
    cuerpo: string,
    min: number,
    relacionados = false,
  ): Promise<Par> {
    const e = { solicitante, ficha: fichaDe(dueno), cuerpo, relacionados, ahora: minuto(min) }
    const r = await real.solicitar(e)
    const d = await doble.solicitar(e)
    expect(r.mensaje.body).toBe(d.mensaje.body)
    return { real: r.conversationId, doble: d.conversationId }
  }

  /** Lo comparable de una vista de perfil: sin ids de conversación ni de mensajes. */
  function perfilSinVolatiles(v: ConversacionDePerfilVista | null): unknown {
    if (v === null) return null
    return {
      status: v.status,
      direction: v.direction,
      other: v.other,
      vendor: v.vendor,
      lastMessage: v.lastMessage === null ? null : { body: v.lastMessage.body },
      unreadCount: v.unreadCount,
      readOnly: v.readOnly,
      retryAt: v.retryAt,
      otherMarks: {
        deliveredUpTo: v.otherMarks.deliveredUpTo !== null,
        readUpTo: v.otherMarks.readUpTo !== null,
      },
    }
  }

  async function perfilEnAmbos(conv: Par, userId: string): Promise<unknown> {
    const r = perfilSinVolatiles(await real.buscarPerfil(conv.real, userId))
    const d = perfilSinVolatiles(await doble.buscarPerfil(conv.doble, userId))
    expect(d).toEqual(r)
    return r
  }

  it('solicitar: crea PENDING con dos participantes y el primer mensaje; la vista del proveedor es RECEIVED con el nombre del solicitante y rol CONTACT', async () => {
    const conv = await solicitarEnAmbos(parejaId, proveedorId, '¿Tenéis fecha libre?', 1)

    for (const [quien, repo] of implementaciones()) {
      const id = idDe(conv, quien)
      expect((await repo.participantes(id)).sort()).toEqual([parejaId, proveedorId].sort())
      expect(await repo.tipoDe(id)).toBe('PROFILE')
      const pagina = await repo.mensajes(id, { desde: null, limite: 10 })
      expect(pagina.items.map((m) => [m.senderId, m.body])).toEqual([
        [parejaId, '¿Tenéis fecha libre?'],
      ])
      // El par es simétrico: da igual el orden de los dos ids.
      for (const [a, b] of [
        [parejaId, proveedorId],
        [proveedorId, parejaId],
      ] as const) {
        expect(await repo.parDePerfil(a, b)).toEqual({
          conversationId: id,
          requesterId: parejaId,
          vendorUserId: proveedorId,
          status: 'PENDING',
          declinedAt: null,
        })
      }
      expect(await repo.parDePerfil(parejaId, plannerId)).toBeNull()
    }

    expect(await perfilEnAmbos(conv, proveedorId)).toEqual({
      status: 'PENDING',
      direction: 'RECEIVED',
      other: { userId: parejaId, displayName: 'Pareja', role: 'CONTACT' },
      vendor: { id: fichaDe(proveedorId).id, businessName: 'Catering Sol' },
      lastMessage: { body: '¿Tenéis fecha libre?' },
      unreadCount: 1,
      readOnly: true,
      retryAt: null,
      otherMarks: { deliveredUpTo: false, readUpTo: false },
    })
    expect(await perfilEnAmbos(conv, parejaId)).toEqual({
      status: 'PENDING',
      direction: 'SENT',
      other: { userId: proveedorId, displayName: 'Catering Sol', role: 'VENDOR' },
      vendor: { id: fichaDe(proveedorId).id, businessName: 'Catering Sol' },
      lastMessage: { body: '¿Tenéis fecha libre?' },
      unreadCount: 0,
      readOnly: true,
      retryAt: null,
      otherMarks: { deliveredUpTo: false, readUpTo: false },
    })
    // Un tercero no la ve.
    expect(await perfilEnAmbos(conv, invitadoId)).toBeNull()
  })

  it('solicitar: relacionados → ACCEPTED', async () => {
    const conv = await solicitarEnAmbos(plannerId, proveedorId, 'hola', 1, true)
    expect(await perfilEnAmbos(conv, proveedorId)).toMatchObject({
      status: 'ACCEPTED',
      direction: 'RECEIVED',
      readOnly: false,
      unreadCount: 1,
    })
    expect(await perfilEnAmbos(conv, plannerId)).toMatchObject({
      status: 'ACCEPTED',
      readOnly: false,
    })
  })

  it('solicitar: segunda petición con PENDING → SolicitudPendienteError, también en sentido contrario', async () => {
    // Los dos tienen ficha: cada uno podría pedir al otro.
    await solicitarEnAmbos(proveedorId, otroProveedorId, 'primera', 1)

    for (const [, repo] of implementaciones()) {
      await expect(
        repo.solicitar({
          solicitante: proveedorId,
          ficha: fichaDe(otroProveedorId),
          cuerpo: 'otra vez',
          relacionados: false,
          ahora: minuto(2),
        }),
      ).rejects.toBeInstanceOf(SolicitudPendienteError)
      await expect(
        repo.solicitar({
          solicitante: otroProveedorId,
          ficha: fichaDe(proveedorId),
          cuerpo: 'al revés',
          relacionados: false,
          ahora: minuto(2),
        }),
      ).rejects.toBeInstanceOf(SolicitudPendienteError)
      await expect(
        repo.solicitar({
          solicitante: proveedorId,
          ficha: fichaDe(proveedorId),
          cuerpo: 'a mí mismo',
          relacionados: false,
          ahora: minuto(2),
        }),
      ).rejects.toBeInstanceOf(AutocontactoError)
      // Ni el rechazo ni el autocontacto dejan rastro: un solo mensaje.
      const par = await repo.parDePerfil(proveedorId, otroProveedorId)
      const pagina = await repo.mensajes(par?.conversationId ?? '', { desde: null, limite: 10 })
      expect(pagina.items.map((m) => m.body)).toEqual(['primera'])
    }
  })

  it('responder: DECLINED oculta la conversación al proveedor y da retryAt al solicitante; un segundo responder → no-pendiente; el solicitante → no-encontrada', async () => {
    const conv = await solicitarEnAmbos(parejaId, proveedorId, 'hola', 1)

    for (const [quien, repo] of implementaciones()) {
      const id = idDe(conv, quien)
      expect(await repo.responder(id, parejaId, 'DECLINED', minuto(2))).toBe('no-encontrada')
      expect(await repo.responder(id, invitadoId, 'ACCEPTED', minuto(2))).toBe('no-encontrada')
      expect(await repo.responder(randomUUID(), proveedorId, 'ACCEPTED', minuto(2))).toBe(
        'no-encontrada',
      )
      expect(await repo.responder(id, proveedorId, 'DECLINED', minuto(2))).toBe('ok')
      expect(await repo.responder(id, proveedorId, 'ACCEPTED', minuto(3))).toBe('no-pendiente')
      expect(await repo.parDePerfil(parejaId, proveedorId)).toMatchObject({
        status: 'DECLINED',
        declinedAt: minuto(2),
      })
    }

    expect(await perfilEnAmbos(conv, proveedorId)).toBeNull()
    expect(await perfilEnAmbos(conv, parejaId)).toMatchObject({
      status: 'DECLINED',
      direction: 'SENT',
      readOnly: true,
      retryAt: new Date(minuto(2).getTime() + ESPERA_TRAS_RECHAZO_MS),
    })
  })

  it('responder: una conversación de evento no es una solicitud → no-encontrada', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await proveedor(eventId, proveedorId, true)
    const conv = await abrirEnAmbos(eventId, parejaId, proveedorId)
    for (const [quien, repo] of implementaciones()) {
      const id = idDe(conv, quien)
      expect(await repo.responder(id, proveedorId, 'ACCEPTED', minuto(1))).toBe('no-encontrada')
      expect(await repo.buscarPerfil(id, proveedorId)).toBeNull()
    }
  })

  it('solicitar tras rechazo: antes de 24 h espera; después vuelve a PENDING con el historial anterior', async () => {
    const conv = await solicitarEnAmbos(parejaId, proveedorId, 'primera', 1)
    for (const [quien, repo] of implementaciones()) {
      expect(await repo.responder(idDe(conv, quien), proveedorId, 'DECLINED', minuto(2))).toBe('ok')
    }

    const retryAt = minuto(2 + DIA_EN_MIN)
    for (const [, repo] of implementaciones()) {
      const intento = repo.solicitar({
        solicitante: parejaId,
        ficha: fichaDe(proveedorId),
        cuerpo: 'demasiado pronto',
        relacionados: false,
        ahora: minuto(1 + DIA_EN_MIN),
      })
      await expect(intento).rejects.toBeInstanceOf(EsperaTrasRechazoError)
      await expect(intento).rejects.toMatchObject({ details: { retryAt: retryAt.toISOString() } })
    }

    const otra = await solicitarEnAmbos(parejaId, proveedorId, 'segunda', 2 + DIA_EN_MIN)
    expect(otra).toEqual(conv) // la misma conversación, en los dos
    for (const [quien, repo] of implementaciones()) {
      const pagina = await repo.mensajes(idDe(conv, quien), { desde: null, limite: 10 })
      expect(pagina.items.map((m) => m.body)).toEqual(['segunda', 'primera'])
      expect(await repo.parDePerfil(proveedorId, parejaId)).toMatchObject({
        status: 'PENDING',
        declinedAt: null,
      })
    }
    expect(await perfilEnAmbos(conv, proveedorId)).toMatchObject({
      status: 'PENDING',
      direction: 'RECEIVED',
      lastMessage: { body: 'segunda' },
      unreadCount: 2,
      retryAt: null,
    })
  })

  it('perfiles: requestsPending cuenta las recibidas pendientes; unreadTotal sólo las aceptadas', async () => {
    const pendiente = await solicitarEnAmbos(parejaId, proveedorId, 'pendiente', 1)
    const aceptada = await solicitarEnAmbos(plannerId, proveedorId, 'aceptada', 2, true)
    const rechazada = await solicitarEnAmbos(invitadoId, proveedorId, 'rechazada', 3)
    for (const [quien, repo] of implementaciones()) {
      expect(await repo.responder(idDe(rechazada, quien), proveedorId, 'DECLINED', minuto(4))).toBe(
        'ok',
      )
    }
    const enviada = await solicitarEnAmbos(proveedorId, otroProveedorId, 'enviada', 5)

    const resultados: unknown[] = []
    for (const [quien, repo] of implementaciones()) {
      const { items, requestsPending, unreadTotal } = await repo.perfiles(proveedorId)
      // La rechazada no está; orden por último mensaje, más reciente primero.
      expect(items.map((v) => v.id)).toEqual([
        idDe(enviada, quien),
        idDe(aceptada, quien),
        idDe(pendiente, quien),
      ])
      expect(requestsPending).toBe(1)
      expect(unreadTotal).toBe(1)
      const solicitante = await repo.perfiles(invitadoId)
      expect(solicitante.items.map((v) => [v.status, v.retryAt])).toEqual([
        ['DECLINED', new Date(minuto(4).getTime() + ESPERA_TRAS_RECHAZO_MS)],
      ])
      expect([solicitante.requestsPending, solicitante.unreadTotal]).toEqual([0, 0])
      resultados.push({
        items: items.map(perfilSinVolatiles),
        solicitante: solicitante.items.map(perfilSinVolatiles),
      })
    }
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('tienenRelacion: miembro ACTIVE ↔ proveedor BOOKED de evento publicado sí; dos proveedores del mismo evento no; evento sin publicar con proveedor no', async () => {
    const v1 = (await nuevoProveedor('Relación Uno')).userId
    const v2 = (await nuevoProveedor('Relación Dos')).userId
    const v3 = (await nuevoProveedor('Relación Tres')).userId
    const m1 = await crearUsuario('relacion-m1@perfil.test', 'Miembro Uno')
    const m2 = await crearUsuario('relacion-m2@perfil.test', 'Miembro Dos')
    const m3 = await crearUsuario('relacion-m3@perfil.test', 'Miembro Tres')
    const invitado = await crearUsuario('relacion-inv@perfil.test', 'Invitado Rel')
    const publicado = await nuevoEvento(true)
    await miembro(publicado, m1, 'COUPLE')
    await miembro(publicado, m3, 'PLANNER')
    await miembro(publicado, invitado, 'PLANNER', 'INVITED')
    await proveedor(publicado, v1, true)
    await proveedor(publicado, v2, true)
    const borrador = await nuevoEvento(false)
    await miembro(borrador, m2, 'COUPLE')
    await proveedor(borrador, v3, true)

    const casos: Array<[string, string, boolean]> = [
      [m1, v1, true],
      [v1, m1, true],
      [m1, m3, true],
      [v1, v2, false],
      [m2, v3, false],
      [m1, m2, false],
      [m1, invitado, false],
      [invitado, v1, false],
    ]
    for (const [, repo] of implementaciones()) {
      for (const [a, b, esperado] of casos) {
        expect([a, b, await repo.tienenRelacion(a, b)]).toEqual([a, b, esperado])
      }
    }

    // Al publicar el borrador, su miembro y su proveedor ya tienen relación.
    await publicar(borrador, true)
    for (const [, repo] of implementaciones()) {
      expect(await repo.tienenRelacion(m2, v3)).toBe(true)
    }
  })

  it('fichaParaContacto: DRAFT/SUSPENDED → publicada false; id inexistente → null', async () => {
    const publicada = await nuevoProveedor('Ficha Publicada', 'PUBLISHED')
    const borrador = await nuevoProveedor('Ficha Borrador', 'DRAFT')
    const suspendida = await nuevoProveedor('Ficha Suspendida', 'SUSPENDED')
    for (const [, repo] of implementaciones()) {
      expect(await repo.fichaParaContacto(publicada.id)).toEqual(publicada)
      expect(await repo.fichaParaContacto(borrador.id)).toEqual({ ...borrador, publicada: false })
      expect(await repo.fichaParaContacto(suspendida.id)).toEqual({
        ...suspendida,
        publicada: false,
      })
      expect(await repo.fichaParaContacto(randomUUID())).toBeNull()
    }
  })

  it('bandeja y salas no incluyen PROFILE', async () => {
    const eventId = await nuevoEvento(true)
    await miembro(eventId, parejaId, 'COUPLE')
    await proveedor(eventId, proveedorId, true)
    const conv = await solicitarEnAmbos(parejaId, proveedorId, 'por la ficha', 1, true)

    for (const [quien, repo] of implementaciones()) {
      const id = idDe(conv, quien)
      for (const userId of [parejaId, proveedorId]) {
        expect((await repo.bandeja(userId)).items.map((v) => v.id)).not.toContain(id)
        expect((await repo.salas(userId)).items.map((v) => v.id)).not.toContain(id)
        expect(await repo.buscar(id, userId)).toBeNull()
        expect(await repo.buscarSala(id, userId)).toBeNull()
      }
      expect((await repo.bandeja(proveedorId)).unreadTotal).toBe(0)
      // Y al revés: una 1:1 de evento no sale entre los perfiles.
      const directa = await repo.abrir(eventId, parejaId, proveedorId)
      expect((await repo.perfiles(parejaId)).items.map((v) => v.id)).toEqual([id])
      expect(await repo.buscarPerfil(directa.id, parejaId)).toBeNull()
    }
  })
})
