/**
 * Error que el DOMINIO sabe nombrar. Lleva su propio código HTTP porque la
 * traducción a HTTP es una decisión del dominio ("esto es un conflicto"), no
 * del controlador; así el mismo error responde igual desde REST, desde un job
 * de cola o desde un gateway de socket.
 */
export abstract class DomainError extends Error {
  abstract readonly httpStatus: number

  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class NotFoundError extends DomainError {
  readonly httpStatus = 404
  constructor(message: string, code = 'NOT_FOUND') {
    super(message, code)
  }
}

export class ForbiddenError extends DomainError {
  readonly httpStatus = 403
  constructor(message: string, code = 'FORBIDDEN') {
    super(message, code)
  }
}

export class ConflictError extends DomainError {
  readonly httpStatus = 409
  constructor(message: string, code = 'CONFLICT') {
    super(message, code)
  }
}

/** Petición bien formada pero imposible de cumplir. Ej.: invitar sin email. */
export class UnprocessableError extends DomainError {
  readonly httpStatus = 422
  constructor(message: string, code = 'UNPROCESSABLE') {
    super(message, code)
  }
}
