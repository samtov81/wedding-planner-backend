import { Inject, Injectable } from '@nestjs/common'

import { VendorProfileNoDisponibleError } from '../domain/vendor-errors'
import { parseVendorRef, type EntradaVendorRef } from '../domain/vendor-ref'
import {
  EVENT_VENDOR_REPOSITORY,
  type EventVendorRepository,
  type EventVendorVista,
} from './event-vendor.repository'

export interface CrearEventVendor extends EntradaVendorRef {
  category: string
  specialty?: string | undefined
  assignedBudget?: number | undefined
  actorUserId: string
}

@Injectable()
export class AddEventVendorUseCase {
  constructor(@Inject(EVENT_VENDOR_REPOSITORY) private readonly vendors: EventVendorRepository) {}

  async ejecutar(eventId: string, datos: CrearEventVendor): Promise<EventVendorVista> {
    // Falla pronto y con un mensaje útil: el 422 del dominio, no el error de
    // Postgres que produciría el CHECK si esto llegara sin validar.
    const vendorRef = parseVendorRef(datos)

    if (vendorRef.kind === 'linked') {
      // Contratar una ficha en borrador o suspendida no debe poder: sólo
      // PUBLISHED representa un proveedor que se ofrece activamente.
      const perfil = await this.vendors.buscarPerfilPublicado(vendorRef.vendorProfileId)
      if (perfil === null) throw new VendorProfileNoDisponibleError()
    }

    return await this.vendors.crear({
      eventId,
      vendorRef,
      category: datos.category,
      specialty: datos.specialty ?? null,
      assignedBudget: datos.assignedBudget ?? null,
      actorUserId: datos.actorUserId,
    })
  }
}
