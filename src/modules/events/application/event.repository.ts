import type { Ubicacion } from '@/shared/domain'

import type { Event, EventStatus } from '../domain/event'
import type { EventRole, MembershipStatus } from '../domain/event-access'

export interface DatosNuevoEvento {
  name: string
  ownerId: string
  rsvpDeadlineDays?: number | undefined
  weddingDate?: Date | null | undefined
  timezone?: string | undefined
  currency?: string | undefined
  totalBudget?: string | null | undefined
  venue?: Ubicacion | null | undefined
}

export interface CambiosEvento {
  name?: string | undefined
  status?: EventStatus | undefined
  weddingDate?: Date | null | undefined
  timezone?: string | undefined
  currency?: string | undefined
  totalBudget?: string | null | undefined
  venue?: Ubicacion | null | undefined
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
   *
   * `owner` sale de la MISMA lectura (`event.ownerId === userId`): resolver el
   * acceso sigue costando una consulta por fuente.
   */
  buscarMembresiaActiva(
    eventId: string,
    userId: string,
  ): Promise<{ role: EventRole; owner: boolean } | null>

  /**
   * Contratación BOOKED cuya `VendorProfile` pertenece a este usuario, en un
   * evento ACTIVE: un borrador no se enseña a proveedores. Un `EventVendor`
   * externo (`vendorProfileId = null`) nunca casa: no hay cuenta detrás a la
   * que conceder nada.
   */
  buscarContratacionReservada(eventId: string, userId: string): Promise<{ id: string } | null>

  /** Evento + membresía COUPLE del creador, en UNA transacción. Nace DRAFT. */
  crearConMembresia(datos: DatosNuevoEvento): Promise<Event>

  /**
   * Actualización parcial: `undefined` = no tocar, `null` = borrar. La regla
   * de "un ACTIVE no puede quedar incompleto" NO vive aquí: la aplica el caso
   * de uso antes de llamar. Lanza `EventoNoEncontradoError` si no existe.
   */
  actualizar(eventId: string, cambios: CambiosEvento): Promise<Event>

  /**
   * DRAFT → ACTIVE, pero sólo si en el MISMO instante de la escritura el
   * evento sigue teniendo `weddingDate`, `totalBudget` y `venue`: cierra la
   * ventana entre comprobar `camposFaltantesParaPublicar` y escribir, que un
   * PATCH concurrente (`venue: null`, por ejemplo) podía colar. Devuelve
   * `null` si no se pudo escribir (ya no es DRAFT, o volvió a faltar algo)
   * para que el caso de uso decida el motivo exacto con una relectura.
   */
  publicarSiCompleto(eventId: string): Promise<Event | null>

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
