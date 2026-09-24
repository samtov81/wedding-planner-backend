import { NotFoundError, UnprocessableError } from '@/shared/domain'

/** No existe o es de otro evento: mismo 404 (no se revela si el id existe). */
export class ItemDeCronogramaNoEncontradoError extends NotFoundError {
  constructor() {
    super('El ítem del cronograma no existe en este evento', 'SCHEDULE_ITEM_NOT_FOUND')
  }
}

export class RangoDeCronogramaInvalidoError extends UnprocessableError {
  constructor() {
    super('La hora de fin no puede ser anterior a la de inicio', 'INVALID_SCHEDULE_RANGE')
  }
}
