import { Inject, Injectable } from '@nestjs/common'

import { EventVendorNoEncontradoError } from '../domain/vendor-errors'
import {
  EVENT_VENDOR_REPOSITORY,
  type CambiosEventVendor,
  type EventVendorRepository,
  type EventVendorVista,
} from './event-vendor.repository'

/**
 * DESIGN-GAP: la Tarea 10 sólo da la firma de `AddEventVendorUseCase` y
 * `ListEventVendorsUseCase`, pero las rutas PATCH/DELETE que la misma tarea
 * pide sí necesitan un caso de uso — meter la comprobación de existencia en
 * el controlador violaría la regla de dependencia (el controlador ensambla,
 * no decide). Se añade este caso de uso, mínimo, en vez de inventar la
 * comprobación dentro de `EventVendorsController`.
 */
@Injectable()
export class UpdateEventVendorUseCase {
  constructor(@Inject(EVENT_VENDOR_REPOSITORY) private readonly vendors: EventVendorRepository) {}

  async ejecutar(
    eventId: string,
    eventVendorId: string,
    cambios: CambiosEventVendor,
  ): Promise<EventVendorVista> {
    const existente = await this.vendors.buscarPorId(eventId, eventVendorId)
    if (existente === null) throw new EventVendorNoEncontradoError()

    return await this.vendors.actualizar(eventId, eventVendorId, cambios)
  }
}
