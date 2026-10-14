import { ConflictError, NotFoundError, UnprocessableError } from '@/shared/domain'

import type { CampoPublicable } from './publicacion'

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

/**
 * 422 con la lista de lo que falta: la UI la pinta en el paso Revisión (al
 * publicar) o en el campo que se intentó vaciar (al editar un ACTIVE).
 */
export class EventoIncompletoError extends UnprocessableError {
  constructor(faltantes: CampoPublicable[]) {
    super('Faltan datos obligatorios para publicar el evento', 'EVENT_INCOMPLETE', { faltantes })
  }
}

/**
 * 404 tanto si la membresía no existe como si es de otro evento o está
 * REVOKED: Members no enseña las revocadas, así que para quien gestiona no
 * existen. El código es propio (no `NOT_FOUND`) porque la UI sí distingue
 * "este miembro ya no está" de "este evento no existe".
 */
export class MiembroNoEncontradoError extends NotFoundError {
  constructor() {
    super('Ese miembro no existe en este evento', 'MEMBER_NOT_FOUND')
  }
}

/**
 * Aceptar o rechazar sin una INVITED propia. 404 y sin distinguir "el evento
 * no existe" de "no te invitaron": el mismo criterio que el guard.
 */
export class SinInvitacionPendienteError extends NotFoundError {
  constructor() {
    super('No tienes una invitación pendiente para este evento', 'NO_PENDING_INVITATION')
  }
}

/**
 * La membresía del creador no se revoca, no cambia de rol y no recibe grant:
 * ya edita el presupuesto, y un evento sin creador dentro no tendría quién lo
 * gestionara.
 */
export class CreadorIntocableError extends UnprocessableError {
  constructor() {
    super('La membresía de quien creó el evento no se puede cambiar', 'OWNER_MEMBERSHIP_IMMUTABLE')
  }
}
