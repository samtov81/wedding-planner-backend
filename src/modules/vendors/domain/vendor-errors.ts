import { NotFoundError } from '@/shared/domain'

/**
 * Cubre dos casos que el cliente no necesita distinguir: el `eventVendorId`
 * no existe, o existe pero pertenece a OTRO evento. Distinguirlos sería un
 * oráculo para averiguar si un id de otro evento existe — el mismo argumento
 * que el 404 único del `EventAccessGuard` (ver docblock de `EventoNoEncontradoError`).
 */
export class EventVendorNoEncontradoError extends NotFoundError {
  constructor() {
    super('El proveedor no existe en este evento', 'EVENT_VENDOR_NOT_FOUND')
  }
}

/**
 * La ficha del marketplace referenciada no existe, o existe pero no está
 * `PUBLISHED` (está en `DRAFT` o `SUSPENDED`). Contratar sobre una ficha que
 * todavía no es pública, o que se retiró, no debe ser posible: ver Tarea 3
 * sobre por qué retirarse es `SUSPENDED` y no un borrado.
 */
export class VendorProfileNoDisponibleError extends NotFoundError {
  constructor() {
    super('La ficha del marketplace no existe o no está publicada', 'VENDOR_PROFILE_NOT_AVAILABLE')
  }
}
