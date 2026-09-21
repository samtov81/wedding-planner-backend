import type { VendorRef } from '../domain/vendor-ref'

export type EventVendorStatus = 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'

/**
 * Lo que ve quien consulta un `EventVendor`. `vendorRef` reconstruye la unión
 * discriminada de `parseVendorRef` a partir de la fila persistida: el
 * consumidor nunca tiene que mirar por separado `vendorProfileId` y
 * `externalName` para saber cuál de los dos hay.
 */
export interface EventVendorVista {
  id: string
  eventId: string
  vendorRef: VendorRef
  category: string
  specialty: string | null
  assignedBudget: number | null
  status: EventVendorStatus
  createdAt: Date
  updatedAt: Date
}

export interface DatosCrearEventVendor {
  eventId: string
  vendorRef: VendorRef
  category: string
  specialty: string | null
  assignedBudget: number | null
  actorUserId: string
}

export interface CambiosEventVendor {
  category?: string | undefined
  specialty?: string | null | undefined
  assignedBudget?: number | null | undefined
  status?: EventVendorStatus | undefined
}

export interface EventVendorRepository {
  /**
   * Ficha del marketplace `PUBLISHED`. Cualquier otro estado (`DRAFT`,
   * `SUSPENDED`) o inexistencia cuenta como no disponible para contratar —lo
   * decide el caso de uso, no el repositorio, pero necesita este dato para
   * decidirlo.
   */
  buscarPerfilPublicado(vendorProfileId: string): Promise<{ id: string } | null>

  /**
   * Crea el `EventVendor` y escribe el `AuditLog` en la MISMA transacción,
   * igual que `EventRepository.invitarMiembro`: una contratación sin rastro
   * de quién la dio de alta es justo lo que la auditoría existe para impedir.
   */
  crear(datos: DatosCrearEventVendor): Promise<EventVendorVista>

  listarPorEvento(eventId: string): Promise<EventVendorVista[]>

  /** `null` si no existe O si existe pero pertenece a otro evento. */
  buscarPorId(eventId: string, eventVendorId: string): Promise<EventVendorVista | null>

  /**
   * Escribe el `AuditLog` (`event_vendor.updated`) en la MISMA transacción
   * que el cambio, igual que `crear`. `actorUserId` llega por parámetro desde
   * el caso de uso, igual que en `crear`.
   */
  actualizar(
    eventId: string,
    eventVendorId: string,
    cambios: CambiosEventVendor,
    actorUserId: string,
  ): Promise<EventVendorVista>

  /**
   * Escribe el `AuditLog` (`event_vendor.removed`) en la MISMA transacción
   * que el borrado, igual que `crear`. `actorUserId` llega por parámetro
   * desde el caso de uso, igual que en `crear`.
   */
  eliminar(eventId: string, eventVendorId: string, actorUserId: string): Promise<void>
}

export const EVENT_VENDOR_REPOSITORY = Symbol('EVENT_VENDOR_REPOSITORY')
