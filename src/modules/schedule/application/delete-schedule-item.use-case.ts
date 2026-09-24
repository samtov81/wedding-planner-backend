import { Inject, Injectable } from '@nestjs/common'

import { ItemDeCronogramaNoEncontradoError } from '../domain/schedule-errors'
import { SCHEDULE_ITEM_REPOSITORY, type ScheduleItemRepository } from './schedule-item.repository'

@Injectable()
export class DeleteScheduleItemUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  async ejecutar(eventId: string, itemId: string): Promise<void> {
    if (!(await this.items.eliminar(eventId, itemId))) throw new ItemDeCronogramaNoEncontradoError()
  }
}
