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

/**
 * Notas y asignaciones son del planner (spec 2026-11-10 §3). 403: quien llega
 * aquí ya pasó el guard del evento. Las NOTAS son la excepción y responden
 * 404 a quien no es planner, para no revelar que existen.
 */
export class SoloPlannerError extends ForbiddenError {
  constructor() {
    super('Sólo el planner del evento puede hacer esto', 'SCHEDULE_PLANNER_ONLY')
  }
}

/**
 * Se intentó asignar una contratación que no es `BOOKED`, no tiene ficha de
 * proveedor o es de otro evento. Lleva TODOS los ids rechazados en `details`
 * (spec 2026-11-10 §9): rechazar uno a uno obligaría al cliente a reintentar.
 */
export class ProveedorNoAsignableError extends UnprocessableError {
  constructor(eventVendorIds: string[]) {
    super(
      'Alguna contratación no se puede asignar: debe estar contratada y tener ficha de proveedor',
      'SCHEDULE_VENDOR_NOT_ASSIGNABLE',
      { eventVendorIds },
    )
  }
}
