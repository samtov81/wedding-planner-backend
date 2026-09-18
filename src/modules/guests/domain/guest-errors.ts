import { ConflictError, NotFoundError } from '@/shared/domain'

/**
 * Cubre dos casos que el cliente no necesita distinguir: el `guestId` no
 * existe, o existe pero pertenece a OTRO evento. Distinguirlos sería un
 * oráculo para averiguar si un id ajeno existe — el mismo argumento que el
 * 404 único del `EventAccessGuard`.
 */
export class InvitadoNoEncontradoError extends NotFoundError {
  constructor() {
    super('El invitado no existe en este evento', 'GUEST_NOT_FOUND')
  }
}

/**
 * Traducción de dominio del índice único PARCIAL `(eventId, email)` del
 * esquema (Tarea 3). Es un 409 y no un 422: la petición es correcta, lo que
 * falla es el estado actual del evento — ese correo ya está invitado.
 *
 * DESIGN-GAP: Prisma no nombra el índice al violarlo, devuelve `P2002` con
 * `meta.target`. La traducción se hace por CÓDIGO en el repositorio; asertar
 * sobre el nombre de la restricción daría un test verde que se rompe al
 * renombrarla sin que nada cambie de comportamiento.
 */
export class EmailDuplicadoError extends ConflictError {
  constructor() {
    super('Ya hay un invitado con ese correo en este evento', 'GUEST_EMAIL_DUPLICATED')
  }
}
