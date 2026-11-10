import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type {
  ItemConAsignaciones,
  ScheduleItemRepository,
} from '../application/schedule-item.repository'
import { ItemDeCronogramaNoEncontradoError } from '../domain/schedule-errors'
import { ScheduleItemRepositoryEnMemoria } from './schedule-item.repository.fake'
import { PrismaScheduleItemRepository } from './prisma-schedule-item.repository'

const LUGAR = { name: 'Salón', address: 'Cra 7 #1', lat: 4.6, lng: -74.07, mapboxId: 'poi.2' }

type EstadoContratacion = 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'

/** Categoría de todas las contrataciones de estos tests: `categoryName` se compara literal. */
const CATEGORIA = 'Cronograma Paridad'

const porTexto = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Lo que un test de asignaciones necesita sembrar, igual para el doble (que lo
 * guarda en memoria) y para Postgres (que lo escribe en las tablas de otros
 * módulos). Mismo patrón que la paridad del moodboard.
 */
interface Mundo {
  repo: ScheduleItemRepository
  evento(): Promise<string>
  /** Usuario sin ficha: quien asigna (`assignedById` es FK a users). */
  usuario(nombre: string): Promise<string>
  /** Usuario con ficha de proveedor; en Postgres, `businessName` = `nombre`. */
  proveedor(nombre: string, avatarKey?: string): Promise<string>
  /**
   * Con `userId`, `name` debe ser el del proveedor (en Postgres el nombre sale
   * de su ficha); con `userId: null`, es una contratación externa.
   */
  contratacion(datos: {
    eventId: string
    userId: string | null
    name: string
    status: EstadoContratacion
  }): Promise<string>
  cambiarContratacion(id: string, status: EstadoContratacion): Promise<void>
}

/**
 * Cada caso corre contra el doble y contra Postgres y compara lo que devuelve
 * el puerto. Lo que no puede compararse (ids, timestamps) se excluye con
 * `sinVolatiles`.
 */
describe('Paridad: ScheduleItemRepositoryEnMemoria vs PrismaScheduleItemRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let eventoA: string
  let eventoB: string
  let categoryId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const owner = await prisma.user.create({
      data: { email: 'owner@paridad-schedule.test', passwordHash: 'x', fullName: 'Owner' },
    })
    const eventos = await Promise.all([
      prisma.event.create({ data: { name: 'Boda A', ownerId: owner.id } }),
      prisma.event.create({ data: { name: 'Boda B', ownerId: owner.id } }),
    ])
    eventoA = eventos[0].id
    eventoB = eventos[1].id
    categoryId = (
      await prisma.vendorCategory.create({
        data: { slug: 'cronograma-paridad', name: CATEGORIA, position: 1 },
      })
    ).id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  function sujetos(): Array<[string, ScheduleItemRepository]> {
    return [
      ['doble', new ScheduleItemRepositoryEnMemoria()],
      ['prisma', new PrismaScheduleItemRepository(prisma as unknown as PrismaService)],
    ]
  }

  const sinVolatiles = ({
    id: _id,
    eventId: _e,
    createdAt: _c,
    updatedAt: _u,
    ...resto
  }: Record<string, unknown>) => resto

  it('crea con y sin location', async () => {
    for (const [, repo] of sujetos()) {
      const conLugar = sinVolatiles({
        ...(await repo.crear({
          eventId: eventoA,
          title: 'Ceremonia',
          description: null,
          startsAt: new Date('2027-06-12T18:00:00Z'),
          endsAt: null,
          location: LUGAR,
          status: 'PENDING',
        })),
      })
      expect(conLugar).toEqual({
        title: 'Ceremonia',
        description: null,
        startsAt: new Date('2027-06-12T18:00:00Z'),
        endsAt: null,
        location: LUGAR,
        status: 'PENDING',
      })

      const sinLugar = sinVolatiles({
        ...(await repo.crear({
          eventId: eventoA,
          title: 'Fiesta',
          description: 'Con DJ',
          startsAt: new Date('2027-06-12T22:00:00Z'),
          endsAt: new Date('2027-06-13T02:00:00Z'),
          location: null,
          status: 'PENDING',
        })),
      })
      expect(sinLugar).toEqual({
        title: 'Fiesta',
        description: 'Con DJ',
        startsAt: new Date('2027-06-12T22:00:00Z'),
        endsAt: new Date('2027-06-13T02:00:00Z'),
        location: null,
        status: 'PENDING',
      })
    }
  })

  it('lista tres ítems ordenados por hora', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      const evento = repo instanceof ScheduleItemRepositoryEnMemoria ? eventoA : eventoB
      await repo.crear({
        eventId: evento,
        title: 'Fiesta',
        description: null,
        startsAt: new Date('2027-07-01T22:00:00Z'),
        endsAt: null,
        location: null,
        status: 'PENDING',
      })
      await repo.crear({
        eventId: evento,
        title: 'Ceremonia',
        description: null,
        startsAt: new Date('2027-07-01T18:00:00Z'),
        endsAt: null,
        location: null,
        status: 'PENDING',
      })
      await repo.crear({
        eventId: evento,
        title: 'Recepción',
        description: null,
        startsAt: new Date('2027-07-01T20:00:00Z'),
        endsAt: null,
        location: LUGAR,
        status: 'PENDING',
      })

      const lista = await repo.listarPorEvento(evento)
      resultados.push(
        lista.map((i) => ({
          title: i.title,
          startsAt: i.startsAt,
          status: i.status,
          location: i.location,
        })),
      )
    }
    expect(resultados[0]).toEqual([
      {
        title: 'Ceremonia',
        startsAt: new Date('2027-07-01T18:00:00Z'),
        status: 'PENDING',
        location: null,
      },
      {
        title: 'Recepción',
        startsAt: new Date('2027-07-01T20:00:00Z'),
        status: 'PENDING',
        location: LUGAR,
      },
      {
        title: 'Fiesta',
        startsAt: new Date('2027-07-01T22:00:00Z'),
        status: 'PENDING',
        location: null,
      },
    ])
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('actualizar con location: null y status: IN_PROGRESS', async () => {
    for (const [, repo] of sujetos()) {
      const creado = await repo.crear({
        eventId: eventoA,
        title: 'Brindis',
        description: null,
        startsAt: new Date('2027-08-01T20:00:00Z'),
        endsAt: null,
        location: LUGAR,
        status: 'PENDING',
      })

      const actualizado = sinVolatiles({
        ...(await repo.actualizar(eventoA, creado.id, { location: null, status: 'IN_PROGRESS' })),
      })
      expect(actualizado).toEqual({
        title: 'Brindis',
        description: null,
        startsAt: new Date('2027-08-01T20:00:00Z'),
        endsAt: null,
        location: null,
        status: 'IN_PROGRESS',
      })
    }
  })

  it('actualizar sobre otro evento lanza ItemDeCronogramaNoEncontradoError', async () => {
    for (const [, repo] of sujetos()) {
      const creado = await repo.crear({
        eventId: eventoA,
        title: 'Solo en A',
        description: null,
        startsAt: new Date('2027-09-01T20:00:00Z'),
        endsAt: null,
        location: null,
        status: 'PENDING',
      })

      await expect(repo.actualizar(eventoB, creado.id, { title: 'X' })).rejects.toBeInstanceOf(
        ItemDeCronogramaNoEncontradoError,
      )
    }
  })

  it('eliminar devuelve true y luego false', async () => {
    for (const [, repo] of sujetos()) {
      const creado = await repo.crear({
        eventId: eventoA,
        title: 'Para borrar',
        description: null,
        startsAt: new Date('2027-10-01T20:00:00Z'),
        endsAt: null,
        location: null,
        status: 'PENDING',
      })

      expect(await repo.eliminar(eventoA, creado.id)).toBe(true)
      expect(await repo.eliminar(eventoA, creado.id)).toBe(false)
    }
  })

  // --- Asignaciones y confirmaciones (spec 2026-11-10 §3–§4) ---

  function mundoDoble(): Mundo {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const contrataciones = new Map<string, Parameters<Mundo['contratacion']>[0]>()
    return {
      repo,
      evento: () => {
        const id = randomUUID()
        repo.sembrarEvento(id, { status: 'ACTIVE' })
        return Promise.resolve(id)
      },
      usuario: (nombre) => {
        const id = randomUUID()
        repo.sembrarUsuario({ id, name: nombre })
        return Promise.resolve(id)
      },
      proveedor: (nombre, avatarKey) => {
        const id = randomUUID()
        repo.sembrarUsuario({ id, name: nombre, ...(avatarKey === undefined ? {} : { avatarKey }) })
        return Promise.resolve(id)
      },
      contratacion: (datos) => {
        const id = randomUUID()
        contrataciones.set(id, datos)
        repo.sembrarContratacion({ id, ...datos, categoryName: CATEGORIA })
        return Promise.resolve(id)
      },
      cambiarContratacion: (id, status) => {
        const previa = contrataciones.get(id)
        if (previa === undefined) throw new Error('contratación desconocida')
        repo.sembrarContratacion({ id, ...previa, status, categoryName: CATEGORIA })
        return Promise.resolve()
      },
    }
  }

  function mundoPrisma(): Mundo {
    const repo = new PrismaScheduleItemRepository(prisma as unknown as PrismaService)
    const fichas = new Map<string, string>()
    const crearUsuario = (nombre: string, avatarKey?: string) =>
      prisma.user.create({
        data: {
          email: `${randomUUID()}@par-schedule.test`,
          passwordHash: 'x',
          fullName: nombre,
          ...(avatarKey === undefined ? {} : { avatarKey }),
        },
      })
    return {
      repo,
      evento: async () => {
        const owner = await crearUsuario('Owner')
        const e = await prisma.event.create({
          data: {
            name: 'Boda',
            ownerId: owner.id,
            status: 'ACTIVE',
            weddingDate: new Date('2027-06-12'),
          },
        })
        return e.id
      },
      usuario: async (nombre) => (await crearUsuario(nombre)).id,
      proveedor: async (nombre, avatarKey) => {
        const u = await crearUsuario(nombre, avatarKey)
        const perfil = await prisma.vendorProfile.create({
          data: { userId: u.id, businessName: nombre, categoryId },
        })
        fichas.set(u.id, perfil.id)
        return u.id
      },
      contratacion: async (datos) => {
        const ficha = datos.userId === null ? undefined : fichas.get(datos.userId)
        const e = await prisma.eventVendor.create({
          data: {
            eventId: datos.eventId,
            categoryId,
            status: datos.status,
            ...(ficha === undefined ? { externalName: datos.name } : { vendorProfileId: ficha }),
          },
        })
        return e.id
      },
      cambiarContratacion: async (id, status) => {
        await prisma.eventVendor.update({ where: { id }, data: { status } })
      },
    }
  }

  /** Los dos sujetos, cada uno con su propio mundo sembrado desde cero. */
  async function conAmbos(caso: (m: Mundo, nombre: string) => Promise<void>): Promise<void> {
    for (const [nombre, m] of [
      ['doble', mundoDoble()],
      ['prisma', mundoPrisma()],
    ] as const) {
      await caso(m, nombre)
    }
  }

  function item(m: Mundo, eventId: string, title: string, startsAt: string, endsAt?: string) {
    return m.repo.crear({
      eventId,
      title,
      description: null,
      startsAt: new Date(startsAt),
      endsAt: endsAt === undefined ? null : new Date(endsAt),
      location: null,
      status: 'PENDING',
    })
  }

  /** Un proveedor con su contratación BOOKED en `eventId`. */
  async function contratado(m: Mundo, eventId: string, nombre: string, avatarKey?: string) {
    const userId = await m.proveedor(nombre, avatarKey)
    const eventVendorId = await m.contratacion({ eventId, userId, name: nombre, status: 'BOOKED' })
    return { userId, eventVendorId }
  }

  /** Lo comparable de un ítem con asignaciones: sin ids ni timestamps. */
  const vistaDe = (i: ItemConAsignaciones) => ({
    title: i.title,
    vendors: i.vendors.map(({ eventVendorId: _ev, ...resto }) => resto),
  })

  it('listarConAsignaciones trae los vendors vigentes con confirmed, por nombre', async () => {
    const resultados: unknown[] = []
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const banda = await contratado(m, eventId, 'Banda Sol')
      const catering = await contratado(m, eventId, 'Catering Luz')
      const fotos = await contratado(m, eventId, 'Fotos Mar')
      const fiesta = await item(m, eventId, 'Fiesta', '2027-06-12T22:00:00Z')
      const ceremonia = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      await m.repo.fijarAsignaciones(
        ceremonia.id,
        [catering.eventVendorId, banda.eventVendorId, fotos.eventVendorId],
        planner,
      )
      await m.repo.confirmar(
        eventId,
        banda.userId,
        await m.repo.pendientesDe(eventId, banda.userId),
      )
      // Cancelada: deja de verse en `vendors`, aunque la fila sigue.
      await m.cambiarContratacion(fotos.eventVendorId, 'CANCELLED')

      const lista = await m.repo.listarConAsignaciones(eventId)
      const buscado = await m.repo.buscarConAsignaciones(eventId, ceremonia.id)
      expect(buscado).toEqual(lista[0])
      expect(lista[0]?.vendors.map((v) => v.eventVendorId)).toEqual([
        banda.eventVendorId,
        catering.eventVendorId,
      ])
      expect(await m.repo.buscarConAsignaciones(eventId, randomUUID())).toBeNull()
      expect(lista.map((i) => i.id)).toEqual([ceremonia.id, fiesta.id])
      resultados.push(lista.map(vistaDe))
    })
    expect(resultados[0]).toEqual([
      {
        title: 'Ceremonia',
        vendors: [
          { name: 'Banda Sol', categoryName: CATEGORIA, confirmed: true },
          { name: 'Catering Luz', categoryName: CATEGORIA, confirmed: false },
        ],
      },
      { title: 'Fiesta', vendors: [] },
    ])
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('listarAsignables excluye SHORTLISTED, CANCELLED, externas y otros eventos', async () => {
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const otroEvento = await m.evento()
      const zeta = await contratado(m, eventId, 'Zeta Música')
      const alfa = await contratado(m, eventId, 'Alfa Flores')
      const corta = await m.proveedor('Lista Corta')
      await m.contratacion({ eventId, userId: corta, name: 'Lista Corta', status: 'SHORTLISTED' })
      const cancelado = await m.proveedor('Cancelado')
      await m.contratacion({ eventId, userId: cancelado, name: 'Cancelado', status: 'CANCELLED' })
      await m.contratacion({ eventId, userId: null, name: 'Externo', status: 'BOOKED' })
      await contratado(m, otroEvento, 'Otro Evento')

      expect(await m.repo.listarAsignables(eventId)).toEqual([
        {
          eventVendorId: alfa.eventVendorId,
          name: 'Alfa Flores',
          categoryName: CATEGORIA,
          userId: alfa.userId,
        },
        {
          eventVendorId: zeta.eventVendorId,
          name: 'Zeta Música',
          categoryName: CATEGORIA,
          userId: zeta.userId,
        },
      ])
    })
  })

  it('fijarAsignaciones: [a,b] da altas, [b] da la baja de a y repetir [b] no cambia nada', async () => {
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const a = await contratado(m, eventId, 'Proveedor A')
      const b = await contratado(m, eventId, 'Proveedor B')
      const ceremonia = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      const ab = [a.eventVendorId, b.eventVendorId]

      expect(await m.repo.fijarAsignaciones(ceremonia.id, ab, planner)).toEqual({
        altas: [...ab].sort(porTexto),
        bajas: [],
      })
      expect(await m.repo.fijarAsignaciones(ceremonia.id, [b.eventVendorId], planner)).toEqual({
        altas: [],
        bajas: [a.eventVendorId],
      })
      expect(await m.repo.fijarAsignaciones(ceremonia.id, [b.eventVendorId], planner)).toEqual({
        altas: [],
        bajas: [],
      })
      expect(await m.repo.usuariosAsignados(ceremonia.id)).toEqual([b.userId])
    })
  })

  it('fijarAsignaciones conserva la fila de una contratación cancelada y nace sin confirmar', async () => {
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const a = await contratado(m, eventId, 'Proveedor A')
      const b = await contratado(m, eventId, 'Proveedor B')
      const ceremonia = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      await m.repo.fijarAsignaciones(ceremonia.id, [a.eventVendorId], planner)
      await m.cambiarContratacion(a.eventVendorId, 'CANCELLED')

      // El planner sólo ve (y reenvía) las vigentes: la de A no es baja.
      expect(await m.repo.fijarAsignaciones(ceremonia.id, [b.eventVendorId], planner)).toEqual({
        altas: [b.eventVendorId],
        bajas: [],
      })
      await m.cambiarContratacion(a.eventVendorId, 'BOOKED')
      const recuperado = await m.repo.buscarConAsignaciones(eventId, ceremonia.id)
      expect(recuperado?.vendors.map(({ name, confirmed }) => ({ name, confirmed }))).toEqual([
        { name: 'Proveedor A', confirmed: false },
        { name: 'Proveedor B', confirmed: false },
      ])
    })
  })

  it('desconfirmarItem deja confirmed:false en todas las asignaciones del ítem', async () => {
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const a = await contratado(m, eventId, 'Proveedor A')
      const ceremonia = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      const fiesta = await item(m, eventId, 'Fiesta', '2027-06-12T22:00:00Z')
      await m.repo.fijarAsignaciones(ceremonia.id, [a.eventVendorId], planner)
      await m.repo.fijarAsignaciones(fiesta.id, [a.eventVendorId], planner)
      await m.repo.confirmar(eventId, a.userId, await m.repo.pendientesDe(eventId, a.userId))
      const antes = await m.repo.listarConAsignaciones(eventId)
      expect(antes.map((i) => i.vendors[0]?.confirmed)).toEqual([true, true])

      await m.repo.desconfirmarItem(ceremonia.id)

      const despues = await m.repo.listarConAsignaciones(eventId)
      expect(despues.map((i) => i.vendors[0]?.confirmed)).toEqual([false, true])
    })
  })

  it('Review Focus 1: confirmar con lo visto deja pendiente el ítem que cambió de hora', async () => {
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const prov = await contratado(m, eventId, 'Proveedor')
      const item1 = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      const item2 = await item(m, eventId, 'Recepción', '2027-06-12T20:00:00Z')
      const item3 = await item(m, eventId, 'Fiesta', '2027-06-12T22:00:00Z')
      for (const i of [item1, item2, item3]) {
        await m.repo.fijarAsignaciones(i.id, [prov.eventVendorId], planner)
      }

      // El proveedor mira la pantalla...
      const vistos = await m.repo.pendientesDe(eventId, prov.userId)
      expect(vistos).toEqual([
        { itemId: item1.id, startsAt: new Date('2027-06-12T18:00:00Z'), endsAt: null },
        { itemId: item2.id, startsAt: new Date('2027-06-12T20:00:00Z'), endsAt: null },
        { itemId: item3.id, startsAt: new Date('2027-06-12T22:00:00Z'), endsAt: null },
      ])
      // ...el planner mueve la hora del ítem 1 y pone fin al 3...
      await m.repo.actualizar(eventId, item1.id, { startsAt: new Date('2027-06-12T18:30:00Z') })
      await m.repo.actualizar(eventId, item3.id, { endsAt: new Date('2027-06-13T02:00:00Z') })
      // ...y el proveedor pulsa "confirmar" con lo que tenía delante.
      await m.repo.confirmar(eventId, prov.userId, vistos)

      expect(await m.repo.pendientesDe(eventId, prov.userId)).toEqual([
        { itemId: item1.id, startsAt: new Date('2027-06-12T18:30:00Z'), endsAt: null },
        {
          itemId: item3.id,
          startsAt: new Date('2027-06-12T22:00:00Z'),
          endsAt: new Date('2027-06-13T02:00:00Z'),
        },
      ])
      const lista = await m.repo.listarConAsignaciones(eventId)
      expect(lista.map((i) => [i.title, i.vendors[0]?.confirmed])).toEqual([
        ['Ceremonia', false],
        ['Recepción', true],
        ['Fiesta', false],
      ])
      expect(await m.repo.usuariosConPendientes(eventId)).toEqual([prov.userId])
    })
  })

  it('confirmar no toca asignaciones de otro proveedor ni ítems de otro evento', async () => {
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const otroEvento = await m.evento()
      const planner = await m.usuario('Planner')
      const a = await contratado(m, eventId, 'Proveedor A')
      const b = await contratado(m, eventId, 'Proveedor B')
      const ceremonia = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      await m.repo.fijarAsignaciones(ceremonia.id, [a.eventVendorId, b.eventVendorId], planner)
      const vistosA = await m.repo.pendientesDe(eventId, a.userId)

      await m.repo.confirmar(otroEvento, a.userId, vistosA)
      expect(await m.repo.pendientesDe(eventId, a.userId)).toEqual(vistosA)

      await m.repo.confirmar(eventId, a.userId, vistosA)
      expect(await m.repo.pendientesDe(eventId, a.userId)).toEqual([])
      expect(await m.repo.usuariosConPendientes(eventId)).toEqual([b.userId])
    })
  })

  it('un proveedor con dos contrataciones aparece una sola vez en estadoConfirmaciones', async () => {
    const resultados: unknown[] = []
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const flores = await m.proveedor('Flores del Sur', 'avatars/flores.png')
      const c1 = await m.contratacion({
        eventId,
        userId: flores,
        name: 'Flores del Sur',
        status: 'BOOKED',
      })
      const c2 = await m.contratacion({
        eventId,
        userId: flores,
        name: 'Flores del Sur',
        status: 'BOOKED',
      })
      const banda = await contratado(m, eventId, 'Banda Sol')
      await contratado(m, eventId, 'Sin Asignar')
      const ceremonia = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      const fiesta = await item(m, eventId, 'Fiesta', '2027-06-12T22:00:00Z')
      await m.repo.fijarAsignaciones(ceremonia.id, [c1, banda.eventVendorId], planner)
      await m.repo.fijarAsignaciones(fiesta.id, [c2], planner)
      // Flores confirma sólo lo de la ceremonia: no está listo hasta confirmar las dos.
      const pendientes = await m.repo.pendientesDe(eventId, flores)
      expect(pendientes.map((p) => p.itemId)).toEqual([ceremonia.id, fiesta.id])
      await m.repo.confirmar(eventId, flores, pendientes.slice(0, 1))
      const sinTerminar = await m.repo.estadoConfirmaciones(eventId)
      await m.repo.confirmar(
        eventId,
        banda.userId,
        await m.repo.pendientesDe(eventId, banda.userId),
      )
      await m.repo.confirmar(eventId, flores, await m.repo.pendientesDe(eventId, flores))
      const terminado = await m.repo.estadoConfirmaciones(eventId)

      expect(sinTerminar.map((e) => e.userId)).toEqual([banda.userId, flores])
      expect(await m.repo.usuariosAsignados(ceremonia.id)).toEqual(
        [flores, banda.userId].sort(porTexto),
      )
      const sinId = (l: { userId: string }[]) => l.map(({ userId: _u, ...resto }) => resto)
      resultados.push([sinId(sinTerminar), sinId(terminado)])
    })
    expect(resultados[0]).toEqual([
      [
        { name: 'Banda Sol', avatarKey: null, ready: false },
        { name: 'Flores del Sur', avatarKey: 'avatars/flores.png', ready: false },
      ],
      [
        { name: 'Banda Sol', avatarKey: null, ready: true },
        { name: 'Flores del Sur', avatarKey: 'avatars/flores.png', ready: true },
      ],
    ])
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('una contratación CANCELLED desaparece de estadoConfirmaciones y usuariosAsignados, y vuelve al recontratar', async () => {
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const prov = await contratado(m, eventId, 'Proveedor')
      const ceremonia = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      await m.repo.fijarAsignaciones(ceremonia.id, [prov.eventVendorId], planner)
      const presente = [{ userId: prov.userId, name: 'Proveedor', avatarKey: null, ready: false }]
      expect(await m.repo.estadoConfirmaciones(eventId)).toEqual(presente)
      expect(await m.repo.usuariosAsignados(ceremonia.id)).toEqual([prov.userId])

      await m.cambiarContratacion(prov.eventVendorId, 'CANCELLED')
      expect(await m.repo.estadoConfirmaciones(eventId)).toEqual([])
      expect(await m.repo.usuariosAsignados(ceremonia.id)).toEqual([])
      expect(await m.repo.pendientesDe(eventId, prov.userId)).toEqual([])
      expect(await m.repo.usuariosConPendientes(eventId)).toEqual([])

      await m.cambiarContratacion(prov.eventVendorId, 'BOOKED')
      expect(await m.repo.estadoConfirmaciones(eventId)).toEqual(presente)
      expect(await m.repo.usuariosAsignados(ceremonia.id)).toEqual([prov.userId])
    })
  })

  it('usuariosConPendientes sólo devuelve usuarios con alguna asignación vigente sin confirmar', async () => {
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const confirmado = await contratado(m, eventId, 'Confirmado')
      const pendiente = await contratado(m, eventId, 'Pendiente')
      const cancelado = await contratado(m, eventId, 'Cancelado')
      await contratado(m, eventId, 'Sin Asignar')
      const ceremonia = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      await m.repo.fijarAsignaciones(
        ceremonia.id,
        [confirmado.eventVendorId, pendiente.eventVendorId, cancelado.eventVendorId],
        planner,
      )
      await m.repo.confirmar(
        eventId,
        confirmado.userId,
        await m.repo.pendientesDe(eventId, confirmado.userId),
      )
      await m.cambiarContratacion(cancelado.eventVendorId, 'CANCELLED')

      expect(await m.repo.usuariosConPendientes(eventId)).toEqual([pendiente.userId])
    })
  })

  it('eliminar el ítem se lleva sus asignaciones', async () => {
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const prov = await contratado(m, eventId, 'Proveedor')
      const ceremonia = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      await m.repo.fijarAsignaciones(ceremonia.id, [prov.eventVendorId], planner)

      await m.repo.eliminar(eventId, ceremonia.id)

      expect(await m.repo.estadoConfirmaciones(eventId)).toEqual([])
      expect(await m.repo.usuariosConPendientes(eventId)).toEqual([])
    })
  })
})
