import { Inject, Injectable } from '@nestjs/common'

import {
  CambioDeEstadoNoPermitidoError,
  ItemDeCronogramaNoEncontradoError,
  RangoDeCronogramaInvalidoError,
} from '../domain/schedule-errors'
import { rangoValido, type ScheduleItem } from '../domain/schedule-item'
import {
  type CambiosItem,
  SCHEDULE_ITEM_REPOSITORY,
  type ScheduleItemRepository,
} from './schedule-item.repository'

/**
 * Lo que el caso de uso necesita saber de quien escribe. Lo resuelve el
 * controlador con `puedeCambiarEstadoDelCronograma` (events/domain): la regla
 * vive allí una sola vez y aquí llega ya decidida, sin que el cronograma
 * conozca roles. Es obligatorio a propósito: olvidarlo no compila, en vez de
 * abrir el estado a cualquiera por defecto.
 */
export interface ActorDelCronograma {
  puedeCambiarEstado: boolean
}

@Injectable()
export class UpdateScheduleItemUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  /**
   * El rango se valida contra lo guardado: un PATCH puede traer solo el fin.
   *
   * Un `status` en el cuerpo de quien no puede cambiarlo es 403 aunque
   * coincida con el guardado: el cliente no tiene por qué mandarlo (el
   * formulario de edición no lo envía), y aceptarlo "si no cambia nada"
   * obligaría a leer antes de decidir sin ganar nada.
   */
  async ejecutar(
    eventId: string,
    itemId: string,
    cambios: CambiosItem,
    actor: ActorDelCronograma,
  ): Promise<ScheduleItem> {
    const actual = await this.items.buscarPorId(eventId, itemId)
    if (actual === null) throw new ItemDeCronogramaNoEncontradoError()
    if (cambios.status !== undefined && !actor.puedeCambiarEstado) {
      throw new CambioDeEstadoNoPermitidoError()
    }
    const startsAt = cambios.startsAt ?? actual.startsAt
    const endsAt = cambios.endsAt !== undefined ? cambios.endsAt : actual.endsAt
    if (!rangoValido(startsAt, endsAt)) throw new RangoDeCronogramaInvalidoError()
    return await this.items.actualizar(eventId, itemId, cambios)
  }
}
