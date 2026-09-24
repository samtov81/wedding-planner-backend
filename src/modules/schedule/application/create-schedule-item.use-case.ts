import { Inject, Injectable } from '@nestjs/common'

import { RangoDeCronogramaInvalidoError } from '../domain/schedule-errors'
import { rangoValido, type ScheduleItem } from '../domain/schedule-item'
import {
  type DatosNuevoItem,
  SCHEDULE_ITEM_REPOSITORY,
  type ScheduleItemRepository,
} from './schedule-item.repository'

export type EntradaNuevoItem = Omit<DatosNuevoItem, 'eventId' | 'status'> & {
  status?: DatosNuevoItem['status'] | undefined
}

@Injectable()
export class CreateScheduleItemUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  async ejecutar(eventId: string, entrada: EntradaNuevoItem): Promise<ScheduleItem> {
    if (!rangoValido(entrada.startsAt, entrada.endsAt)) throw new RangoDeCronogramaInvalidoError()
    return await this.items.crear({ ...entrada, eventId, status: entrada.status ?? 'PENDING' })
  }
}
