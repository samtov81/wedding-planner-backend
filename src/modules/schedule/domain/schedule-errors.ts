import { ForbiddenError, NotFoundError, UnprocessableError } from '@/shared/domain'

/**
 * Sólo el planner (o ADMIN) mueve el estado de un ítem. 403 y no 404: quien
 * llega aquí ya pasó el guard del evento, así que no se revela nada nuevo.
 */
export class CambioDeEstadoNoPermitidoError extends ForbiddenError {
  constructor() {
    super('Sólo el planner del evento puede cambiar el estado', 'SCHEDULE_STATUS_PLANNER_ONLY')
  }
}

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
