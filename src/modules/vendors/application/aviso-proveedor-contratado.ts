import type { Logger } from '@nestjs/common'

import { TIPO_PROVEEDOR_CONTRATADO } from '@/modules/notifications/application/notification.port'
import type { QueuePort } from '@/modules/queue/application/queue.port'

/**
 * Contrato del aviso en tiempo real a un proveedor del marketplace al que un
 * evento acaba de contratar (`event.vendor.booked`, spec 2026-10-29). Vive en
 * `vendors/application` porque lo PRODUCE `UpdateEventVendorUseCase`; el worker
 * de `notifications` lo importa de aquí, como ya hace con `aviso-invitacion.ts`.
 *
 * Por qué la FILA va dentro de la transacción y el AVISO por cola: la
 * `Notification` es lo que un proveedor desconectado recupera por REST, así que
 * se confirma con el cambio de estado o no se confirma; el `notification.created`
 * es sólo latencia y se encola DESPUÉS de confirmar. Si Redis falla, el
 * proveedor lo ve al recargar.
 *
 * El destinatario es SÓLO el `VendorProfile.userId` de la contratación: la
 * pareja y los planners ya saben que contrataron.
 */
export interface JobProveedorContratado {
  eventId: string
  /** El destinatario del aviso: el dueño de la ficha contratada. */
  userId: string
}

/**
 * Único por CONTRATACIÓN y por momento, no sólo por contratación: cancelar y
 * volver a contratar es otro aviso del mismo `eventVendorId`, y BullMQ
 * descartaría el segundo por jobId repetido. Con `-`, nunca `:`.
 */
export function jobIdDeProveedorContratado(eventVendorId: string, en: Date): string {
  return `vendor-booked-${eventVendorId}-${en.getTime()}`
}

/**
 * Encola el aviso en tiempo real. Cuando se llama, la contratación y la
 * `Notification` ya están confirmadas, así que un fallo de Redis se registra
 * con un `warn` y NO se propaga: convertiría en error una operación que sí se
 * hizo (igual que `encolarAvisoRespuesta`).
 */
export async function encolarAvisoProveedor(
  cola: QueuePort,
  registro: Logger,
  job: JobProveedorContratado,
  eventVendorId: string,
): Promise<void> {
  try {
    await cola.enqueue('notifications', TIPO_PROVEEDOR_CONTRATADO, job, {
      jobId: jobIdDeProveedorContratado(eventVendorId, new Date()),
    })
  } catch (error) {
    registro.warn(
      `Contratación registrada pero su aviso no se pudo encolar eventId=${job.eventId}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }
}
