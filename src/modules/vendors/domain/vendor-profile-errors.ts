import { ConflictError, NotFoundError, UnprocessableError } from '@/shared/domain'

/** El usuario aún no creó su ficha (switch nunca encendido), o no está publicada. */
export class FichaNoEncontradaError extends NotFoundError {
  constructor() {
    super('No existe esa ficha de proveedor', 'VENDOR_PROFILE_NOT_FOUND')
  }
}

export class FichaSuspendidaError extends ConflictError {
  constructor() {
    super('La ficha está suspendida: no se puede publicar ni ocultar', 'VENDOR_PROFILE_SUSPENDED')
  }
}

export class FotoNoEncontradaError extends NotFoundError {
  constructor() {
    super('La foto no existe en tu portfolio', 'PORTFOLIO_IMAGE_NOT_FOUND')
  }
}

export class LimiteDeFotosError extends UnprocessableError {
  constructor() {
    super('El portfolio admite como máximo 20 fotos', 'PORTFOLIO_LIMIT_EXCEEDED')
  }
}

/** El nuevo orden no es exactamente el conjunto de fotos actual. */
export class OrdenDeFotosInvalidoError extends UnprocessableError {
  constructor() {
    super('El orden debe incluir cada foto del portfolio una sola vez', 'PORTFOLIO_ORDER_INVALID')
  }
}
