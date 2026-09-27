import { Inject, Injectable } from '@nestjs/common'

import { EventVendorNoEncontradoError } from '../domain/vendor-errors'
import { CategoriasDeProveedor } from './categorias'
import {
  type CambiosEventVendor,
  EVENT_VENDOR_REPOSITORY,
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
/** Lo que pide la API: la categoría llega como `slug`. */
export interface CambiosPedidos extends Omit<CambiosEventVendor, 'category'> {
  category?: string | undefined
}

@Injectable()
export class UpdateEventVendorUseCase {
  constructor(
    @Inject(EVENT_VENDOR_REPOSITORY) private readonly vendors: EventVendorRepository,
    private readonly categorias: CategoriasDeProveedor,
  ) {}

  async ejecutar(
    eventId: string,
    eventVendorId: string,
    cambios: CambiosPedidos,
    actorUserId: string,
  ): Promise<EventVendorVista> {
    const existente = await this.vendors.buscarPorId(eventId, eventVendorId)
    if (existente === null) throw new EventVendorNoEncontradoError()

    const { category, ...resto } = cambios
    return await this.vendors.actualizar(
      eventId,
      eventVendorId,
      {
        ...resto,
        ...(category === undefined ? {} : { category: await this.categorias.resolver(category) }),
      },
      actorUserId,
    )
  }
}
