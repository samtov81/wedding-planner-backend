import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '@/shared/domain'

/**
 * El texto del mensaje no sirve: queda vacío al recortar o pasa de 2000
 * caracteres. El 400 "de cara al cliente" lo da Zod en el controlador; este
 * error es la segunda barrera, por si otro camino (un gateway, un worker)
 * llega al dominio sin pasar por ese esquema. Alternativa descartada: un
 * `ValidationError` propio; basta `UnprocessableError` (422), que ya existe.
 */
export class MensajeInvalidoError extends UnprocessableError {
  constructor(message = 'El mensaje debe tener entre 1 y 2000 caracteres') {
    super(message, 'MESSAGE_INVALID')
  }
}

/**
 * La conversación no existe o el usuario no es participante: ambos casos
 * responden igual para que un id ajeno no confirme que existe.
 */
export class ConversacionNoEncontradaError extends NotFoundError {
  constructor() {
    super('La conversación no existe', 'CONVERSATION_NOT_FOUND')
  }
}

/** Un proveedor no puede escribir a otro proveedor del mismo evento. */
export class ParNoPermitidoError extends ForbiddenError {
  constructor() {
    super('No puedes iniciar una conversación con esa persona', 'CONVERSATION_PAIR_NOT_ALLOWED')
  }
}

/**
 * La conversación sólo se puede leer: quien escribe o el otro participante ya
 * no tienen acceso al evento.
 */
export class ConversacionSoloLecturaError extends ForbiddenError {
  constructor() {
    super('Esta conversación es de solo lectura', 'CONVERSATION_READ_ONLY')
  }
}

/** Quien pide no tiene hoy acceso al evento en el que quiere conversar. */
export class SinAccesoAlEventoError extends ForbiddenError {
  constructor() {
    super('No tienes acceso a este evento', 'EVENT_ACCESS_DENIED')
  }
}

/**
 * La sala del evento no está disponible para quien la pide: un proveedor (los
 * proveedores nunca están en la sala), un administrador del sistema que no es
 * miembro, un INVITED que nunca estuvo o alguien sin relación con el evento.
 */
export class SalaNoDisponibleError extends ForbiddenError {
  constructor() {
    super('No tienes acceso a la sala de este evento', 'ROOM_ACCESS_DENIED')
  }
}

/**
 * La ficha pública no existe o no está publicada. Ambos casos responden igual
 * para que un id de ficha en borrador no confirme que existe.
 */
export class FichaNoDisponibleError extends NotFoundError {
  constructor() {
    super('La ficha no está disponible', 'VENDOR_PROFILE_NOT_FOUND')
  }
}

/** Un proveedor no puede contactar con su propia ficha. */
export class AutocontactoError extends UnprocessableError {
  constructor() {
    super('No puedes contactar con tu propia ficha', 'CONTACT_SELF')
  }
}

/** Ya hay una solicitud de contacto pendiente entre las dos personas (409 al pedir). */
export class SolicitudPendienteError extends ConflictError {
  constructor() {
    super('Ya hay una solicitud de contacto pendiente', 'CONTACT_REQUEST_PENDING')
  }
}

/**
 * Escribir en una conversación cuya solicitud sigue pendiente (403). Mismo
 * código que `SolicitudPendienteError` a propósito: es el mismo estado visto
 * desde otra acción; sólo cambia el estado HTTP (409 al pedir, 403 al escribir).
 */
export class EscrituraEnSolicitudPendienteError extends ForbiddenError {
  constructor() {
    super('La solicitud de contacto sigue pendiente', 'CONTACT_REQUEST_PENDING')
  }
}

/** El contacto ya está aceptado: el cliente recibe la conversación para abrirla. */
export class ContactoYaAceptadoError extends ConflictError {
  constructor(conversationId: string) {
    super('El contacto ya está aceptado', 'CONTACT_ALREADY_ACCEPTED', { conversationId })
  }
}

/** Se rechazó hace menos de 24 h; `retryAt` (ISO) dice cuándo se puede volver a pedir. */
export class EsperaTrasRechazoError extends ConflictError {
  constructor(retryAt: Date) {
    super('Debes esperar antes de volver a pedir contacto', 'CONTACT_REQUEST_COOLDOWN', {
      retryAt: retryAt.toISOString(),
    })
  }
}

/** Quien rechazó la solicitud no puede ser quien vuelva a pedirla. */
export class RechazadoPorTiError extends ConflictError {
  constructor() {
    super('Rechazaste esta solicitud de contacto', 'CONTACT_DECLINED_BY_YOU')
  }
}

/** Aceptar o rechazar una solicitud que ya no está pendiente. */
export class SolicitudNoPendienteError extends ConflictError {
  constructor() {
    super('La solicitud de contacto ya no está pendiente', 'CONTACT_REQUEST_NOT_PENDING')
  }
}
