import { Processor, WorkerHost } from '@nestjs/bullmq'
import { UnrecoverableError, type Job } from 'bullmq'
import { z } from 'zod'

import { EventAccessService } from '@/modules/events/application/event-access.service'
import { TIPO_GASTO_PAGADO } from '@/modules/notifications/application/notification.port'
import {
  NOTIFICACION_CREADA,
  REALTIME_PORT,
  type RealtimePort,
} from '@/modules/notifications/application/realtime.port'
import { Inject } from '@nestjs/common'

import {
  COLA_GASTOS,
  EVENTO_GASTO_CAMBIADO,
  EVENTO_PAGO_PROVEEDOR_CAMBIADO,
  type JobGastoCambiado,
} from '../application/avisos-gastos'

/** Entrada de Redis: se valida y `satisfies` la ata al tipo del productor. */
const gastoCambiadoSchema = z.object({
  eventId: z.guid(),
  proveedoresA: z.array(z.guid()),
  campanaA: z.array(z.guid()),
}) satisfies z.ZodType<JobGastoCambiado>

/**
 * Worker de la cola `expenses` (spec 2026-11-11 §9). Emite con payload
 * `{ eventId }`: el cliente relee por REST, así un aviso nunca filtra importes.
 *  - `expense.changed` → `user:<id>` de quien ve el presupuesto AHORA
 *    (`usuariosConPresupuesto`, releído): un grant revocado entre el encolado y
 *    el consumo no recibe nada. Alternativa descartada: la sala `event:<id>`,
 *    que incluye a miembros sin grant.
 *  - `vendor-payment.changed` → cada `proveedoresA` del job (sólo el caso de uso
 *    sabía quién veía el gasto antes del cambio).
 *  - `notification.created` → cada `campanaA`: su fila ya está confirmada.
 * Job desconocido o payload roto: `UnrecoverableError` (reintentar no lo arregla
 * y retornar lo marcaría completado). Los errores de emisión salen y BullMQ
 * reintenta; un reintento puede repetir emisiones, que el cliente absorbe.
 */
@Processor(COLA_GASTOS)
export class GastosProcessor extends WorkerHost {
  constructor(
    private readonly acceso: EventAccessService,
    @Inject(REALTIME_PORT) private readonly tiempoReal: RealtimePort,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name !== EVENTO_GASTO_CAMBIADO) {
      throw new UnrecoverableError(`Job desconocido en la cola ${COLA_GASTOS}: ${job.name}`)
    }
    const leido = gastoCambiadoSchema.safeParse(job.data)
    // El mensaje no lleva el payload: los ids de usuario no van a los jobs fallidos.
    if (!leido.success) throw new UnrecoverableError(`Payload inválido en el job ${job.name}`)
    const { eventId, proveedoresA, campanaA } = leido.data

    const payload = { eventId }
    for (const userId of await this.acceso.usuariosConPresupuesto(eventId)) {
      await this.tiempoReal.emitirAUsuario(userId, EVENTO_GASTO_CAMBIADO, payload)
    }
    for (const userId of proveedoresA) {
      await this.tiempoReal.emitirAUsuario(userId, EVENTO_PAGO_PROVEEDOR_CAMBIADO, payload)
    }
    for (const userId of campanaA) {
      await this.tiempoReal.emitirAUsuario(userId, NOTIFICACION_CREADA, {
        eventId,
        type: TIPO_GASTO_PAGADO,
      })
    }
  }
}
