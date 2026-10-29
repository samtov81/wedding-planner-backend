import { ForbiddenError, NotFoundError, UnprocessableError } from '@/shared/domain'

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
