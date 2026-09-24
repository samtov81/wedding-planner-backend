import { randomUUID } from 'node:crypto'

import type { Ubicacion } from '@/shared/domain'

import type {
  CambiosEvento,
  DatosInvitacion,
  DatosNuevoEvento,
  EventRepository,
  MembresiaPersistida,
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

  buscarMembresiaActiva(eventId: string, userId: string): Promise<{ role: EventRole } | null> {
    const membresia = this.membresias.find(
      (m) => m.eventId === eventId && m.userId === userId && m.status === MEMBRESIA_CON_ACCESO,
    )
    return Promise.resolve(membresia === undefined ? null : { role: membresia.role })
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
    for (const clave of Object.keys(cambios) as Array<keyof CambiosEvento>) {
      const valor = cambios[clave]
      if (valor !== undefined) Object.assign(evento, { [clave]: valor })
    }
    return Promise.resolve(this.materializar(evento))
  }

  listarAccesiblesPor(userId: string): Promise<Event[]> {
    const porMembresia = this.membresias
      .filter((m) => m.userId === userId && m.status === MEMBRESIA_CON_ACCESO)
      .map((m) => m.eventId)

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

    const ids = new Set([...porMembresia, ...porContratacion])
    return Promise.resolve(
      this.eventos.filter((e) => ids.has(e.id)).map((e) => this.materializar(e)),
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
    if (existente === undefined) this.membresias.push(membresia)

    this.auditoria.push({
      actorUserId: datos.invitedById,
      eventId: datos.eventId,
      action: 'event.member.invited',
      target: `user:${datos.userId}`,
    })
    return Promise.resolve({ id: membresia.id, role: membresia.role, status: 'INVITED' })
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
