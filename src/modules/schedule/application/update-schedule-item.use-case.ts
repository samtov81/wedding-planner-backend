import { Inject, Injectable } from '@nestjs/common'

import {
  ItemDeCronogramaNoEncontradoError,
  RangoDeCronogramaInvalidoError,
} from '../domain/schedule-errors'
import { rangoValido, type ScheduleItem } from '../domain/schedule-item'
import {
  type CambiosItem,
  SCHEDULE_ITEM_REPOSITORY,
  type ScheduleItemRepository,
} from './schedule-item.repository'

@Injectable()
export class UpdateScheduleItemUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  /** El rango se valida contra lo guardado: un PATCH puede traer solo el fin. */
  async ejecutar(eventId: string, itemId: string, cambios: CambiosItem): Promise<ScheduleItem> {
    const actual = await this.items.buscarPorId(eventId, itemId)
    if (actual === null) throw new ItemDeCronogramaNoEncontradoError()
    const startsAt = cambios.startsAt ?? actual.startsAt
    const endsAt = cambios.endsAt !== undefined ? cambios.endsAt : actual.endsAt
    if (!rangoValido(startsAt, endsAt)) throw new RangoDeCronogramaInvalidoError()
    return await this.items.actualizar(eventId, itemId, cambios)
  }
}
