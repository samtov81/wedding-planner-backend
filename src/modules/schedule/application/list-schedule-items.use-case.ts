import { Inject, Injectable } from '@nestjs/common'

import type { ScheduleItem } from '../domain/schedule-item'
import { SCHEDULE_ITEM_REPOSITORY, type ScheduleItemRepository } from './schedule-item.repository'

@Injectable()
export class ListScheduleItemsUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  async ejecutar(eventId: string): Promise<ScheduleItem[]> {
    return await this.items.listarPorEvento(eventId)
  }
}
