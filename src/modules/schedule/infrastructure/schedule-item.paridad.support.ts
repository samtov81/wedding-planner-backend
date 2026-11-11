import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import type { ScheduleItemRepository } from '../application/schedule-item.repository'
import { PrismaScheduleItemRepository } from './prisma-schedule-item.repository'
import { ScheduleItemRepositoryEnMemoria } from './schedule-item.repository.fake'

/*
 * Arnés compartido de las paridades del repositorio del cronograma: el mundo
 * sembrado para el doble y para Postgres. Se extrajo de
 * `schedule-item.repository.paridad.test.ts` para que las notas
 * (`schedule-item-notas.paridad.test.ts`) no dupliquen ~100 líneas de
 * sembrado. Alternativa descartada: meter todo en un único fichero de
 * paridad, que ya pasaba de 700 líneas.
 */

export type EstadoContratacion = 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'

/** Categoría de todas las contrataciones de estos tests: `categoryName` se compara literal. */
export const CATEGORIA = 'Cronograma Paridad'

/** Lo que el mundo de Postgres necesita del `beforeAll` del test que lo usa. */
export interface ContextoPrisma {
  prisma: PrismaClient
  categoryId: string
}

/**
 * Lo que un test de asignaciones necesita sembrar, igual para el doble (que lo
 * guarda en memoria) y para Postgres (que lo escribe en las tablas de otros
 * módulos). Mismo patrón que la paridad del moodboard.
 */
export interface Mundo {
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
  estadoEvento(eventId: string, status: 'DRAFT' | 'ACTIVE'): Promise<void>
  cambiarContratacion(id: string, status: EstadoContratacion): Promise<void>
}

/**
 * Un `userId` sin ficha de proveedor degradaba en silencio a una contratación
 * externa en Postgres, mientras el doble la guardaba como de usuario: una
 * divergencia fabricada por el test, no por el repositorio. Mejor romper.
 */
function sinFichaNoHayContratacionDeUsuario(userId: string | null, tieneFicha: boolean): void {
  if (userId !== null && !tieneFicha) {
    throw new Error(`el usuario ${userId} no tiene ficha de proveedor: usa m.proveedor()`)
  }
}

export function mundoDoble(): Mundo {
  const repo = new ScheduleItemRepositoryEnMemoria()
  const contrataciones = new Map<string, Parameters<Mundo['contratacion']>[0]>()
  const conFicha = new Set<string>()
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
      conFicha.add(id)
      return Promise.resolve(id)
    },
    contratacion: (datos) => {
      sinFichaNoHayContratacionDeUsuario(datos.userId, conFicha.has(datos.userId ?? ''))
      const id = randomUUID()
      contrataciones.set(id, datos)
      repo.sembrarContratacion({ id, ...datos, categoryName: CATEGORIA })
      return Promise.resolve(id)
    },
    estadoEvento: (eventId, status) => {
      repo.sembrarEvento(eventId, { status })
      return Promise.resolve()
    },
    cambiarContratacion: (id, status) => {
      const previa = contrataciones.get(id)
      if (previa === undefined) throw new Error('contratación desconocida')
      repo.sembrarContratacion({ id, ...previa, status, categoryName: CATEGORIA })
      return Promise.resolve()
    },
  }
}

export function mundoPrisma({ prisma, categoryId }: ContextoPrisma): Mundo {
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
      sinFichaNoHayContratacionDeUsuario(datos.userId, ficha !== undefined)
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
    estadoEvento: async (eventId, status) => {
      await prisma.event.update({ where: { id: eventId }, data: { status } })
    },
    cambiarContratacion: async (id, status) => {
      await prisma.eventVendor.update({ where: { id }, data: { status } })
    },
  }
}

/** Los dos sujetos, cada uno con su propio mundo sembrado desde cero. */
export async function conAmbos(
  contexto: () => ContextoPrisma,
  caso: (m: Mundo, nombre: string) => Promise<void>,
): Promise<void> {
  for (const [nombre, m] of [
    ['doble', mundoDoble()],
    ['prisma', mundoPrisma(contexto())],
  ] as const) {
    await caso(m, nombre)
  }
}

export function item(m: Mundo, eventId: string, title: string, startsAt: string, endsAt?: string) {
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
export async function contratado(m: Mundo, eventId: string, nombre: string, avatarKey?: string) {
  const userId = await m.proveedor(nombre, avatarKey)
  const eventVendorId = await m.contratacion({ eventId, userId, name: nombre, status: 'BOOKED' })
  return { userId, eventVendorId }
}
