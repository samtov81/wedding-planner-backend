import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableError,
} from '@/shared/domain'

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

/**
 * Enviar una invitación a alguien sin correo es imposible, no prohibido ni
 * inexistente: 422. La petición está bien formada y el invitado existe; lo que
 * falta es el dato que hace posible la operación. En el envío MASIVO este mismo
 * caso no lanza — aparece en `skipped` con motivo `NO_EMAIL`—, porque un
 * invitado sin correo no puede abortar el envío a los otros 149.
 */
export class GuestHasNoEmailError extends UnprocessableError {
  constructor() {
    super('El invitado no tiene correo al que enviar la invitación', 'GUEST_HAS_NO_EMAIL')
  }
}

/**
 * La firma del webhook del proveedor no casa, falta o ha caducado. En una ruta
 * pública la firma ES la autenticación, así que es un 401 como el de un token
 * inválido.
 *
 * DESIGN-GAP: el brief la declara `extends DomainError` con `httpStatus = 401`.
 * Aquí extiende `UnauthorizedError`, que ya es exactamente eso: mismo status y
 * mismo mapeo en `DomainExceptionFilter`, sin repetir el 401 a mano, y queda
 * agrupada con los demás "identidad rechazada" si alguien filtra por clase.
 */
export class FirmaInvalidaError extends UnauthorizedError {
  constructor() {
    super('La firma del webhook no es válida', 'INVALID_SIGNATURE')
  }
}
