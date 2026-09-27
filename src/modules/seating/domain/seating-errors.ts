import { ConflictError, NotFoundError, UnprocessableError } from '@/shared/domain'

/** No existe o es de otro evento: mismo 404 (no se revela si el id existe). */
export class MesaNoEncontradaError extends NotFoundError {
  constructor() {
    super('La mesa no existe en este evento', 'TABLE_NOT_FOUND')
  }
}

export class AsientoFueraDeRangoError extends UnprocessableError {
  constructor() {
    super('La mesa no tiene ese asiento', 'SEAT_OUT_OF_RANGE')
  }
}

/** El invitado no existe en el evento, rechazó, o ese acompañante excede sus plazas. */
export class OcupanteInvalidoError extends UnprocessableError {
  constructor() {
    super('Esa persona no se puede sentar', 'SEAT_OCCUPANT_INVALID')
  }
}

export class AsientoOcupadoError extends ConflictError {
  constructor() {
    super('Solo se pueden quitar asientos vacíos', 'SEAT_NOT_EMPTY')
  }
}

export class LimiteDeMesasError extends UnprocessableError {
  constructor() {
    super('Un evento admite como máximo 100 mesas', 'TABLE_LIMIT_EXCEEDED')
  }
}

export class RangoDeAsientosInvalidoError extends UnprocessableError {
  constructor() {
    super(
      'Los asientos deben cumplir 1 ≤ mínimo ≤ asientos ≤ máximo ≤ 20',
      'TABLE_SEATS_OUT_OF_RANGE',
    )
  }
}
