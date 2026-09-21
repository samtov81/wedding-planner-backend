import { ConflictError, NotFoundError, UnprocessableError } from '@/shared/domain'

/**
 * El MISMO error que produce el guard para un evento ajeno. Se comparte el
 * código y el mensaje a propósito: si el 404 de "no es tuyo" se distinguiera
 * del de "no existe", el guard dejaría de esconder nada.
 */
export class EventoNoEncontradoError extends NotFoundError {
  constructor() {
    super('El evento no existe', 'NOT_FOUND')
  }
}

/**
 * Invitar exige una cuenta: `EventMembership.userId` es una FK a `users`, así
 * que no hay dónde colgar una invitación a un email sin registrar. 422 y no
 * 404: la petición está bien formada, es el mundo el que no la admite todavía.
 * DESIGN-GAP: la especificación no dice qué pasa al invitar a un desconocido.
 * Lo correcto a largo plazo es una invitación pendiente por email, que necesita
 * una tabla propia (la misma que falta para verificar el email en el registro,
 * DESIGN-GAP #6). Hasta que exista, se rechaza explícitamente en vez de fingir.
 */
export class InvitadoSinCuentaError extends UnprocessableError {
  constructor() {
    super(
      'No hay ninguna cuenta con ese email; la persona debe registrarse primero',
      'INVITEE_HAS_NO_ACCOUNT',
    )
  }
}

export class YaEsMiembroError extends ConflictError {
  constructor() {
    super(
      'Esa persona ya es miembro de este evento o tiene una invitación pendiente',
      'ALREADY_MEMBER',
    )
  }
}
