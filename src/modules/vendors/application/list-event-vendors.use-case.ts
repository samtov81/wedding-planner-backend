import { Inject, Injectable } from '@nestjs/common'

import {
  EVENT_VENDOR_REPOSITORY,
  type EventVendorRepository,
  type EventVendorVista,
} from './event-vendor.repository'

@Injectable()
export class ListEventVendorsUseCase {
  constructor(@Inject(EVENT_VENDOR_REPOSITORY) private readonly vendors: EventVendorRepository) {}

  async ejecutar(eventId: string): Promise<EventVendorVista[]> {
    return await this.vendors.listarPorEvento(eventId)
  }
}
