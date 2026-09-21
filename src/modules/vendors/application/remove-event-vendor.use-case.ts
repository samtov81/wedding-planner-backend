import { Inject, Injectable } from '@nestjs/common'

import { EventVendorNoEncontradoError } from '../domain/vendor-errors'
import { EVENT_VENDOR_REPOSITORY, type EventVendorRepository } from './event-vendor.repository'

/** Ver DESIGN-GAP en `update-event-vendor.use-case.ts`: mismo motivo de existir. */
@Injectable()
export class RemoveEventVendorUseCase {
  constructor(@Inject(EVENT_VENDOR_REPOSITORY) private readonly vendors: EventVendorRepository) {}

  async ejecutar(eventId: string, eventVendorId: string, actorUserId: string): Promise<void> {
    const existente = await this.vendors.buscarPorId(eventId, eventVendorId)
    if (existente === null) throw new EventVendorNoEncontradoError()

    await this.vendors.eliminar(eventId, eventVendorId, actorUserId)
  }
}
