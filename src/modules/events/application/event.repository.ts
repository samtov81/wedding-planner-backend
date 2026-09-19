import type { Event } from '../domain/event'
import type { EventRole, MembershipStatus } from '../domain/event-access'

export interface DatosNuevoEvento {
  name: string
  weddingDate: Date
  ownerId: string
  /** Ausente = `DIAS_DE_CIERRE_POR_DEFECTO`, el default de la columna. */
  rsvpDeadlineDays?: number | undefined
}

export interface DatosInvitacion {
  eventId: string
  userId: string
  role: EventRole
  invitedById: string
}

export interface MembresiaPersistida {
  id: string
  role: EventRole
  status: MembershipStatus
}

export interface EventRepository {
  /**
   * Membresía ACTIVA, y sólo ACTIVA. Que el filtro de estado viva dentro del
   * repositorio (y no en el servicio) es deliberado: así ningún adaptador
   * futuro puede devolver una `INVITED` y conceder acceso sin querer.
   */
  buscarMembresiaActiva(eventId: string, userId: string): Promise<{ role: EventRole } | null>

  /**
   * Contratación BOOKED cuya `VendorProfile` pertenece a este usuario. Un
   * `EventVendor` externo (`vendorProfileId = null`) nunca casa: no hay cuenta
   * detrás a la que conceder nada.
   */
  buscarContratacionReservada(eventId: string, userId: string): Promise<{ id: string } | null>

  /** Evento + membresía COUPLE del creador, en UNA transacción. */
  crearConMembresia(datos: DatosNuevoEvento): Promise<Event>

  /** Eventos con membresía ACTIVA, más aquellos donde el usuario está BOOKED. */
  listarAccesiblesPor(userId: string): Promise<Event[]>

  buscarPorId(eventId: string): Promise<Event | null>

  /** Cualquier membresía, en cualquier estado: para detectar duplicados. */
  buscarMembresia(eventId: string, userId: string): Promise<MembresiaPersistida | null>

  /**
   * Crea la membresía en INVITED y escribe el `AuditLog` en la MISMA
   * transacción. Van juntos porque una invitación sin rastro de quién la
   * cursó es exactamente lo que el log de auditoría existe para impedir.
   */
  invitarMiembro(datos: DatosInvitacion): Promise<MembresiaPersistida>
}

export const EVENT_REPOSITORY = Symbol('EVENT_REPOSITORY')
