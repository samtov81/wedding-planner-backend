import { Inject, Injectable } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import {
  NOTIFICATION_PORT,
  type NotificationPort,
} from '@/modules/notifications/application/notification.port'

import { EventVendorNoEncontradoError, ProveedorConGastosError } from '../domain/vendor-errors'
import { EVENT_VENDOR_REPOSITORY, type EventVendorRepository } from './event-vendor.repository'

/**
 * Ver DESIGN-GAP en `update-event-vendor.use-case.ts`: mismo motivo de existir.
 *
 * Borrar la contratación retira también su `event.vendor.booked`, en la MISMA
 * transacción: sin ello el aviso quedaría huérfano (apuntando a un evento que ya
 * no contrata al proveedor) y, si la pareja vuelve a añadirlo y contratarlo, el
 * proveedor vería dos avisos de la misma contratación (spec: una fila por
 * contratación).
 */
@Injectable()
export class RemoveEventVendorUseCase {
  constructor(
    @Inject(EVENT_VENDOR_REPOSITORY) private readonly vendors: EventVendorRepository,
    @Inject(NOTIFICATION_PORT) private readonly notificaciones: NotificationPort,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
  ) {}

  async ejecutar(eventId: string, eventVendorId: string, actorUserId: string): Promise<void> {
    const existente = await this.vendors.buscarPorId(eventId, eventVendorId)
    if (existente === null) throw new EventVendorNoEncontradoError()

    if (await this.vendors.tieneGastos(eventId, eventVendorId)) throw new ProveedorConGastosError()

    await this.unidadDeTrabajo.ejecutar(async () => {
      await this.vendors.eliminar(eventId, eventVendorId, actorUserId)
      await this.notificaciones.retirarAvisoProveedor(eventId, eventVendorId)
    })
  }
}
