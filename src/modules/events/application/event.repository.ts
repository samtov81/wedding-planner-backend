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

/** Una fila de Members: viva (INVITED o ACTIVE), con nombre y email del usuario. */
export interface MiembroPersistido {
  id: string
  userId: string
  fullName: string
  email: string
  role: EventRole
  status: 'INVITED' | 'ACTIVE'
  owner: boolean
  budgetView: boolean
}

/** Una membresía por su id, en cualquier estado: lo que el caso de uso valida. */
export interface MembresiaGestionable {
  id: string
  userId: string
  role: EventRole
  status: MembershipStatus
  owner: boolean
  budgetView: boolean
}

/** `undefined` = no tocar. */
export interface CambiosMembresia {
  role?: EventRole | undefined
  budgetView?: boolean | undefined
}

/** Una invitación INVITED del usuario, con lo que la UI enseña para decidir. */
export interface InvitacionPendiente {
  membershipId: string
  eventId: string
  eventName: string
  role: EventRole
  invitedByName: string | null
}

/** Un evento del listado, con el grant de presupuesto de quien lista. */
export interface EventoAccesible {
  evento: Event
  /** Grant de su membresía ACTIVE; `false` si llega sólo por contratación. */
  budgetView: boolean
}

export interface EventRepository {
  /**
   * Membresía ACTIVA, y sólo ACTIVA. Que el filtro de estado viva dentro del
   * repositorio (y no en el servicio) es deliberado: así ningún adaptador
   * futuro puede devolver una `INVITED` y conceder acceso sin querer.
   *
   * `owner` sale de la MISMA lectura (`event.ownerId === userId`): resolver el
   * acceso sigue costando una consulta por fuente. `budgetView` (grant de
   * presupuesto) también sale de esa lectura.
   */
  buscarMembresiaActiva(
    eventId: string,
    userId: string,
  ): Promise<{ role: EventRole; owner: boolean; budgetView: boolean } | null>

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

  /**
   * Eventos con membresía ACTIVA, más aquellos donde el usuario está BOOKED,
   * con el grant de cada uno para `accesoAlPresupuestoEnListado`.
   */
  listarAccesiblesPor(userId: string): Promise<EventoAccesible[]>

  buscarPorId(eventId: string): Promise<Event | null>

  /** Cualquier membresía, en cualquier estado: para detectar duplicados. */
  buscarMembresia(eventId: string, userId: string): Promise<MembresiaPersistida | null>

  /**
   * Crea la membresía en INVITED y escribe el `AuditLog` en la MISMA
   * transacción. Van juntos porque una invitación sin rastro de quién la
   * cursó es exactamente lo que el log de auditoría existe para impedir.
   *
   * Borra además cualquier grant de la membresía: una reinvitación nace sin
   * acceso al presupuesto aunque una carrera hubiera dejado uno.
   */
  invitarMiembro(datos: DatosInvitacion): Promise<MembresiaPersistida>

  /**
   * INVITED y ACTIVE (las REVOKED no se gestionan), creador primero y luego
   * por `createdAt` asc, `id` de desempate. Nombre y email salen del join con
   * `users` en la misma consulta.
   */
  listarMiembros(eventId: string): Promise<MiembroPersistido[]>

  /** En cualquier estado, pero sólo si es de ESTE evento. */
  buscarMembresiaPorId(eventId: string, membershipId: string): Promise<MembresiaGestionable | null>

  /**
   * Cambia rol y/o grant + `AuditLog`, en una transacción. Escritura
   * CONDICIONAL: sólo si la membresía sigue INVITED o ACTIVE en este evento;
   * `false` si cambió por debajo (el caso de uso responde 404). El `UPDATE`
   * bloquea la fila hasta el commit, así que un DELETE concurrente espera.
   *
   * Con `cambios` vacío (ni rol ni grant) sólo comprueba que siga viva: no
   * escribe, no toca `updatedAt` y no deja `AuditLog`.
   */
  actualizarMembresia(
    eventId: string,
    membershipId: string,
    cambios: CambiosMembresia,
    actorId: string,
  ): Promise<boolean>

  /**
   * → REVOKED, borra el grant y escribe `AuditLog` (`event.member.revoked` o
   * `event.member.declined`), en una transacción y condicional como la de
   * arriba. Sirve para revocar, cancelar una invitación y rechazarla. Con
   * `declined` la condición es más estricta: sólo vale sobre INVITED, para que
   * un rechazo que pierde la carrera contra un Accept no revoque al ya ACTIVE.
   */
  revocarMembresia(
    eventId: string,
    membershipId: string,
    actorId: string,
    motivo: 'revoked' | 'declined',
  ): Promise<boolean>

  /** INVITED → ACTIVE de la membresía de `userId` + `AuditLog`. `false` si no estaba INVITED. */
  aceptarInvitacion(eventId: string, userId: string): Promise<boolean>

  /**
   * INVITED del usuario, más recientes primero (`updatedAt desc`, `id asc` de
   * desempate), con nombre del evento y de quien invitó.
   */
  listarInvitacionesPendientes(userId: string): Promise<InvitacionPendiente[]>
}

export const EVENT_REPOSITORY = Symbol('EVENT_REPOSITORY')
