import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import {
  NOTIFICATION_PORT,
  type NotificationPort,
} from '@/modules/notifications/application/notification.port'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { EventVendorNoEncontradoError } from '../domain/vendor-errors'
import { encolarAvisoProveedor } from './aviso-proveedor-contratado'
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

/**
 * Pasar una contratación a `BOOKED` avisa al proveedor (spec 2026-10-29 §3).
 * El cambio de estado y la `Notification` van en la MISMA transacción: si crear
 * el aviso falla, la contratación sigue como estaba. Quien decide que hubo
 * transición es la escritura condicionada del repositorio (`contratado`), no
 * una lectura previa, así que dos PATCH a `BOOKED` avisan una sola vez. La
 * cola se encola DESPUÉS de confirmar y su fallo no tumba el PATCH.
 */
@Injectable()
export class UpdateEventVendorUseCase {
  private readonly registro = new Logger(UpdateEventVendorUseCase.name)

  constructor(
    @Inject(EVENT_VENDOR_REPOSITORY) private readonly vendors: EventVendorRepository,
    private readonly categorias: CategoriasDeProveedor,
    @Inject(NOTIFICATION_PORT) private readonly notificaciones: NotificationPort,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
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
    const cambiosResueltos: CambiosEventVendor = {
      ...resto,
      ...(category === undefined ? {} : { category: await this.categorias.resolver(category) }),
    }

    let avisado: string | null = null
    const resultado = await this.unidadDeTrabajo.ejecutar(async () => {
      const r = await this.vendors.actualizar(eventId, eventVendorId, cambiosResueltos, actorUserId)
      const proveedorUserId = r.contratado?.proveedorUserId ?? null
      if (proveedorUserId !== null) {
        await this.notificaciones.avisarAProveedor(eventId, proveedorUserId, eventVendorId)
        avisado = proveedorUserId
      }
      return r
    })

    if (avisado !== null) {
      await encolarAvisoProveedor(
        this.cola,
        this.registro,
        { eventId, userId: avisado },
        eventVendorId,
      )
    }
    return resultado.vista
  }
}
