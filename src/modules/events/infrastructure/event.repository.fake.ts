import { randomUUID } from 'node:crypto'

import type { Ubicacion } from '@/shared/domain'

import type {
  CambiosEvento,
  CambiosMembresia,
  DatosInvitacion,
  DatosNuevoEvento,
  EventoAccesible,
  EventRepository,
  InvitacionPendiente,
  MembresiaGestionable,
  MembresiaPersistida,
  MiembroPersistido,
} from '../application/event.repository'
import {
  DIAS_DE_CIERRE_POR_DEFECTO,
  type ConteosEvento,
  type Event,
  type EventStatus,
} from '../domain/event'
import {
  CONTRATACION_CON_ACCESO,
  MEMBRESIA_CON_ACCESO,
  type EventRole,
  type MembershipStatus,
} from '../domain/event-access'
import { EventoNoEncontradoError } from '../domain/event-errors'

/**
 * Un evento tal como lo siembra un test: basta `id` y `ownerId`. El resto de
 * columnas se rellena con valores por defecto al leerlo, para no obligar a
 * cada test a escribir una fecha de boda que no va a mirar.
 */
export interface EventoEnMemoria {
  id: string
  ownerId: string
  name?: string
  /** Sembrado a mano = evento ya publicado; `crearConMembresia` crea DRAFT. */
  status?: EventStatus
  weddingDate?: Date | null
  timezone?: string
  currency?: string
  totalBudget?: string | null
  venue?: Ubicacion | null
  rsvpDeadlineDays?: number
  conteos?: ConteosEvento
  createdAt?: Date
}

export interface MembresiaEnMemoria {
  id?: string
  eventId: string
  userId: string
  role: EventRole
  status: MembershipStatus
  /** `true` = tiene fila en `event_budget_grants`. */
  budgetView?: boolean
  invitedById?: string
  /** Tic del reloj del doble en la última escritura: el `updatedAt` de Prisma. */
  actualizadaEn?: number
}

/** Lo que `listarMiembros` y las pendientes leen de `users` en Prisma. */
export interface UsuarioEnMemoria {
  id: string
  fullName: string
  email: string
}

export interface PerfilEnMemoria {
  id: string
  userId: string
}

export interface EventVendorEnMemoria {
  id: string
  eventId: string
  vendorProfileId: string | null
  status: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'
}

export interface AuditoriaEnMemoria {
  actorUserId: string
  eventId: string
  action: string
  target: string
}

/**
 * Doble en memoria de `EventRepository` (ruling H1: el doble vive junto al
 * puerto que implementa). Replica las DOS reglas que de verdad deciden el
 * acceso: sólo `ACTIVE` cuenta como membresía y sólo `BOOKED` con ficha
 * enlazada en un evento `ACTIVE` cuenta como contratación. Si el doble fuera
 * más permisivo que Prisma, los tests del servicio pasarían en verde
 * mintiendo.
 */
export class EventRepositoryEnMemoria implements EventRepository {
  readonly eventos: EventoEnMemoria[] = []
  readonly membresias: MembresiaEnMemoria[] = []
  readonly perfiles: PerfilEnMemoria[] = []
  readonly eventVendors: EventVendorEnMemoria[] = []
  readonly auditoria: AuditoriaEnMemoria[] = []
  readonly usuarios: UsuarioEnMemoria[] = []
  /** Monótono: dos escrituras seguidas en Prisma podrían compartir milisegundo. */
  private reloj = 0

  buscarMembresiaActiva(
    eventId: string,
    userId: string,
  ): Promise<{ role: EventRole; owner: boolean; budgetView: boolean } | null> {
    const membresia = this.membresias.find(
      (m) => m.eventId === eventId && m.userId === userId && m.status === MEMBRESIA_CON_ACCESO,
    )
    if (membresia === undefined) return Promise.resolve(null)
    const evento = this.eventos.find((e) => e.id === eventId)
    return Promise.resolve({
      role: membresia.role,
      owner: evento?.ownerId === userId,
      budgetView: membresia.budgetView ?? false,
    })
  }

  buscarContratacionReservada(eventId: string, userId: string): Promise<{ id: string } | null> {
    const perfil = this.perfiles.find((p) => p.userId === userId)
    if (perfil === undefined) return Promise.resolve(null)

    const contratacion = this.eventVendors.find(
      (v) =>
        v.eventId === eventId &&
        v.vendorProfileId === perfil.id &&
        v.status === CONTRATACION_CON_ACCESO &&
        this.estaActivo(v.eventId),
    )
    return Promise.resolve(contratacion === undefined ? null : { id: contratacion.id })
  }

  crearConMembresia(datos: DatosNuevoEvento): Promise<Event> {
    const evento: EventoEnMemoria = {
      id: randomUUID(),
      ownerId: datos.ownerId,
      name: datos.name,
      status: 'DRAFT',
      weddingDate: datos.weddingDate ?? null,
      timezone: datos.timezone ?? 'UTC',
      currency: datos.currency ?? 'USD',
      totalBudget: datos.totalBudget ?? null,
      venue: datos.venue ?? null,
      rsvpDeadlineDays: datos.rsvpDeadlineDays ?? DIAS_DE_CIERRE_POR_DEFECTO,
      conteos: { scheduleItems: 0, vendors: 0 },
      createdAt: new Date(),
    }
    this.eventos.push(evento)
    this.membresias.push({
      id: randomUUID(),
      eventId: evento.id,
      userId: datos.ownerId,
      role: 'COUPLE',
      status: MEMBRESIA_CON_ACCESO,
    })
    return Promise.resolve(this.materializar(evento))
  }

  actualizar(eventId: string, cambios: CambiosEvento): Promise<Event> {
    const evento = this.eventos.find((e) => e.id === eventId)
    if (evento === undefined) return Promise.reject(new EventoNoEncontradoError())
    // `undefined` = no tocar; `null` = borrar. Igual que el `updateMany` de Prisma.
    Object.assign(
      evento,
      Object.fromEntries(Object.entries(cambios).filter(([, valor]) => valor !== undefined)),
    )
    return Promise.resolve(this.materializar(evento))
  }

  /** La MISMA condición que el `updateMany` de Prisma, comprobada al escribir. */
  publicarSiCompleto(eventId: string): Promise<Event | null> {
    const evento = this.eventos.find((e) => e.id === eventId)
    if (evento === undefined) return Promise.resolve(null)
    const materializado = this.materializar(evento)
    if (materializado.status !== 'DRAFT') return Promise.resolve(null)
    if (
      materializado.weddingDate === null ||
      materializado.totalBudget === null ||
      materializado.venue === null
    ) {
      return Promise.resolve(null)
    }
    evento.status = 'ACTIVE'
    return Promise.resolve(this.materializar(evento))
  }

  listarAccesiblesPor(userId: string): Promise<EventoAccesible[]> {
    const activas = this.membresias.filter(
      (m) => m.userId === userId && m.status === MEMBRESIA_CON_ACCESO,
    )

    const perfil = this.perfiles.find((p) => p.userId === userId)
    const porContratacion =
      perfil === undefined
        ? []
        : this.eventVendors
            .filter(
              (v) =>
                v.vendorProfileId === perfil.id &&
                v.status === CONTRATACION_CON_ACCESO &&
                this.estaActivo(v.eventId),
            )
            .map((v) => v.eventId)

    const ids = new Set([...activas.map((m) => m.eventId), ...porContratacion])
    return Promise.resolve(
      this.eventos
        .filter((e) => ids.has(e.id))
        .map((e) => ({
          evento: this.materializar(e),
          budgetView: activas.find((m) => m.eventId === e.id)?.budgetView ?? false,
        })),
    )
  }

  buscarPorId(eventId: string): Promise<Event | null> {
    const evento = this.eventos.find((e) => e.id === eventId)
    return Promise.resolve(evento === undefined ? null : this.materializar(evento))
  }

  buscarMembresia(eventId: string, userId: string): Promise<MembresiaPersistida | null> {
    const membresia = this.membresias.find((m) => m.eventId === eventId && m.userId === userId)
    if (membresia === undefined) return Promise.resolve(null)
    return Promise.resolve({
      id: membresia.id ?? '',
      role: membresia.role,
      status: membresia.status,
    })
  }

  invitarMiembro(datos: DatosInvitacion): Promise<MembresiaPersistida> {
    // Upsert, igual que el adaptador de Prisma: el índice único
    // (eventId, userId) impide una segunda fila, así que re-invitar a alguien
    // revocado reutiliza la suya en vez de fallar.
    const existente = this.membresias.find(
      (m) => m.eventId === datos.eventId && m.userId === datos.userId,
    )
    const membresia = existente ?? {
      id: randomUUID(),
      eventId: datos.eventId,
      userId: datos.userId,
      role: datos.role,
      status: 'INVITED' as const,
    }
    membresia.id ??= randomUUID()
    membresia.role = datos.role
    membresia.status = 'INVITED'
    // Como Prisma: la reinvitación nace sin grant aunque quedara uno huérfano.
    membresia.budgetView = false
    membresia.invitedById = datos.invitedById
    membresia.actualizadaEn = ++this.reloj
    if (existente === undefined) this.membresias.push(membresia)

    this.auditoria.push({
      actorUserId: datos.invitedById,
      eventId: datos.eventId,
      action: 'event.member.invited',
      target: `user:${datos.userId}`,
    })
    return Promise.resolve({ id: membresia.id, role: membresia.role, status: 'INVITED' })
  }

  listarMiembros(eventId: string): Promise<MiembroPersistido[]> {
    const ownerId = this.eventos.find((e) => e.id === eventId)?.ownerId
    const vivas = this.membresias.filter(
      (m) => m.eventId === eventId && (m.status === 'INVITED' || m.status === 'ACTIVE'),
    )
    const miembros = vivas.map((m) => {
      const u = this.usuarios.find((x) => x.id === m.userId)
      return {
        id: m.id ?? '',
        userId: m.userId,
        fullName: u?.fullName ?? '',
        email: u?.email ?? '',
        role: m.role,
        status: m.status as 'INVITED' | 'ACTIVE',
        owner: m.userId === ownerId,
        budgetView: m.budgetView ?? false,
      }
    })
    // Inserción = `createdAt` asc, como Prisma; creador primero.
    return Promise.resolve(miembros.sort((a, b) => Number(b.owner) - Number(a.owner)))
  }

  buscarMembresiaPorId(
    eventId: string,
    membershipId: string,
  ): Promise<MembresiaGestionable | null> {
    const m = this.membresias.find((x) => x.id === membershipId && x.eventId === eventId)
    if (m === undefined) return Promise.resolve(null)
    const ownerId = this.eventos.find((e) => e.id === eventId)?.ownerId
    return Promise.resolve({
      id: membershipId,
      userId: m.userId,
      role: m.role,
      status: m.status,
      owner: m.userId === ownerId,
      budgetView: m.budgetView ?? false,
    })
  }

  actualizarMembresia(
    eventId: string,
    membershipId: string,
    cambios: CambiosMembresia,
    actorId: string,
  ): Promise<boolean> {
    const m = this.viva(eventId, membershipId)
    if (m === undefined) return Promise.resolve(false)
    if (cambios.role !== undefined) m.role = cambios.role
    if (cambios.budgetView !== undefined) m.budgetView = cambios.budgetView
    // Prisma fuerza `updatedAt` en esta escritura: también reordena las pendientes.
    m.actualizadaEn = ++this.reloj
    this.auditoria.push({
      actorUserId: actorId,
      eventId,
      action: 'event.member.updated',
      target: `membership:${membershipId}`,
    })
    return Promise.resolve(true)
  }

  revocarMembresia(
    eventId: string,
    membershipId: string,
    actorId: string,
    motivo: 'revoked' | 'declined',
  ): Promise<boolean> {
    const m = this.viva(eventId, membershipId)
    if (m === undefined) return Promise.resolve(false)
    // Igual que el `WHERE` de Prisma: rechazar sólo vale sobre INVITED.
    if (motivo === 'declined' && m.status !== 'INVITED') return Promise.resolve(false)
    m.status = 'REVOKED'
    m.budgetView = false
    m.actualizadaEn = ++this.reloj
    this.auditoria.push({
      actorUserId: actorId,
      eventId,
      action: `event.member.${motivo}`,
      target: `membership:${membershipId}`,
    })
    return Promise.resolve(true)
  }

  aceptarInvitacion(eventId: string, userId: string): Promise<boolean> {
    const m = this.membresias.find(
      (x) => x.eventId === eventId && x.userId === userId && x.status === 'INVITED',
    )
    if (m === undefined) return Promise.resolve(false)
    m.status = MEMBRESIA_CON_ACCESO
    m.actualizadaEn = ++this.reloj
    this.auditoria.push({
      actorUserId: userId,
      eventId,
      action: 'event.member.accepted',
      target: `user:${userId}`,
    })
    return Promise.resolve(true)
  }

  listarInvitacionesPendientes(userId: string): Promise<InvitacionPendiente[]> {
    const pendientes = this.membresias
      .filter((m) => m.userId === userId && m.status === 'INVITED')
      .sort((a, b) => (b.actualizadaEn ?? 0) - (a.actualizadaEn ?? 0))
    return Promise.resolve(
      pendientes.map((m) => {
        const evento = this.eventos.find((e) => e.id === m.eventId)
        return {
          membershipId: m.id ?? '',
          eventId: m.eventId,
          eventName: this.materializar(evento ?? { id: m.eventId, ownerId: '' }).name,
          role: m.role,
          invitedByName:
            m.invitedById === undefined
              ? null
              : (this.usuarios.find((u) => u.id === m.invitedById)?.fullName ?? null),
        }
      }),
    )
  }

  /** INVITED o ACTIVE de este evento: lo mismo que el `WHERE` condicional de Prisma. */
  private viva(eventId: string, membershipId: string): MembresiaEnMemoria | undefined {
    return this.membresias.find(
      (x) =>
        x.id === membershipId &&
        x.eventId === eventId &&
        (x.status === 'INVITED' || x.status === 'ACTIVE'),
    )
  }

  private estaActivo(eventId: string): boolean {
    return (this.eventos.find((e) => e.id === eventId)?.status ?? 'ACTIVE') === 'ACTIVE'
  }

  /** Rellena las columnas que un test no siembra, para devolver un `Event`. */
  private materializar(evento: EventoEnMemoria): Event {
    return {
      id: evento.id,
      name: evento.name ?? 'Evento de prueba',
      status: evento.status ?? 'ACTIVE',
      // Relativa a hoy: con una fecha fija, este evento por defecto habría
      // quedado con su RSVP cerrado en cuanto pasara ese día.
      weddingDate:
        evento.weddingDate === undefined
          ? new Date(Date.now() + 180 * 86_400_000)
          : evento.weddingDate,
      timezone: evento.timezone ?? 'UTC',
      currency: evento.currency ?? 'USD',
      totalBudget: evento.totalBudget ?? null,
      venue: evento.venue ?? null,
      rsvpDeadlineDays: evento.rsvpDeadlineDays ?? DIAS_DE_CIERRE_POR_DEFECTO,
      ownerId: evento.ownerId,
      conteos: evento.conteos ?? { scheduleItems: 0, vendors: 0 },
      createdAt: evento.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }
  }
}
