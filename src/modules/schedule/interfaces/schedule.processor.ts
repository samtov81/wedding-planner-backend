import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import { z } from 'zod'

import {
  type NotificationPort,
  TIPO_CRONOGRAMA_CONFIRMACION,
  TIPO_CRONOGRAMA_RECORDATORIO,
  TIPO_CRONOGRAMA_REPROGRAMADO,
} from '@/modules/notifications/application/notification.port'
import {
  NOTIFICACION_CREADA,
  type RealtimePort,
} from '@/modules/notifications/application/realtime.port'

import {
  COLA_CRONOGRAMA,
  EVENTO_CAMPANA,
  EVENTO_RECORDATORIO,
  type JobCampana,
  type JobRecordatorio,
} from '../application/avisos-cronograma'
import type { ScheduleItemRepository } from '../application/schedule-item.repository'
import { debeAvisar } from '../domain/participacion'

/**
 * Lo que sale de Redis es ENTRADA (lo escribió otro proceso, quizá con otra
 * versión): se valida, y `satisfies` ata cada esquema al tipo que exporta el
 * productor, como en `MoodboardProcessor`.
 */
const recordatorioSchema = z.object({
  itemId: z.guid(),
  eventVendorId: z.guid(),
  startsAt: z.iso.datetime(),
}) satisfies z.ZodType<JobRecordatorio>

/** Sólo los dos tipos que el cronograma empuja como campana ya persistida. */
const campanaSchema = z.object({
  eventId: z.guid(),
  tipo: z.enum([TIPO_CRONOGRAMA_REPROGRAMADO, TIPO_CRONOGRAMA_CONFIRMACION]),
  userIds: z.array(z.guid()),
}) satisfies z.ZodType<JobCampana>

function leer<T>(esquema: z.ZodType<T>, job: Job): T {
  const leido = esquema.safeParse(job.data)
  // Un payload roto no lo arregla ningún reintento. El mensaje no lleva el
  // payload: los ids de usuario no van a los jobs fallidos.
  if (!leido.success) throw new UnrecoverableError(`Payload inválido en el job ${job.name}`)
  return leido.data
}

/**
 * Worker de la cola `schedule` (spec 2026-11-10 §5–§6).
 *
 * `schedule.item.reminder` — job DIFERIDO hasta `startsAt − 15 min`. Re-lee
 * el estado ACTUAL (`destinoRecordatorio`) y sólo avisa si `debeAvisar`: el
 * ítem existe y sigue `PENDING` con la MISMA `startsAt` que el job, la
 * asignación y la contratación `BOOKED` siguen vigentes, el evento está
 * `ACTIVE` y aún no ha pasado `startsAt`. Los jobs nunca se borran: los
 * obsoletos (cambio de hora, desasignación, cancelación, ítem `DONE`) mueren
 * aquí. Con A→B→A, los dos jobs de la hora A comparten jobId y BullMQ deja
 * uno; el de B se descarta por no coincidir (Review Focus 2).
 *
 * Al avisar, el WORKER crea la fila de la campana (nadie la creó antes: el
 * aviso no existe hasta que llega su hora) y la empuja a `user:<id>`. Si
 * crear la fila falla, el error sale y BullMQ reintenta. Si falla el empuje,
 * se registra y NO se reintenta: la fila ya está y se verá al recargar, y un
 * reintento crearía otra fila (un segundo recordatorio en la campana).
 * Alternativa descartada: dejar salir también el error del socket, como el
 * moodboard; allí la fila la creó el productor en su transacción y un
 * reintento sólo repite emisiones, aquí duplicaría la notificación.
 *
 * `schedule.bell` — la fila ya está confirmada por el productor; se emite
 * `notification.created { eventId, type }` a cada destinatario. Aquí los
 * errores de emisión SÍ salen: reintentar sólo repite emisiones, que el
 * cliente absorbe porque relee.
 *
 * Un nombre de job DESCONOCIDO falla con `UnrecoverableError` (retornar lo
 * marcaría completado y lo perdería en silencio).
 *
 * Se construye con `useFactory` en `ScheduleModule` (el explorador de
 * `@nestjs/bullmq` lo encuentra por `instance.constructor`), y por eso
 * `reloj` es un parámetro con valor por defecto que sólo sustituyen los tests.
 */
@Processor(COLA_CRONOGRAMA)
export class ScheduleProcessor extends WorkerHost {
  private readonly registro = new Logger(ScheduleProcessor.name)

  constructor(
    private readonly items: ScheduleItemRepository,
    private readonly notificaciones: NotificationPort,
    private readonly tiempoReal: RealtimePort,
    private readonly reloj: () => Date = () => new Date(),
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case EVENTO_RECORDATORIO:
        await this.recordatorio(leer(recordatorioSchema, job))
        return
      case EVENTO_CAMPANA:
        await this.campana(leer(campanaSchema, job))
        return
      default:
        throw new UnrecoverableError(`Job desconocido en la cola schedule: ${job.name}`)
    }
  }

  private async recordatorio(job: JobRecordatorio): Promise<void> {
    const destino = await this.items.destinoRecordatorio(job.itemId, job.eventVendorId)
    if (destino === null || !debeAvisar(destino, new Date(job.startsAt), this.reloj())) return

    await this.notificaciones.crearParaUsuarios(
      destino.eventId,
      [destino.userId],
      TIPO_CRONOGRAMA_RECORDATORIO,
      {
        scheduleItemId: job.itemId,
        title: destino.title,
        startsAt: destino.startsAt.toISOString(),
      },
    )
    try {
      await this.tiempoReal.emitirAUsuario(destino.userId, NOTIFICACION_CREADA, {
        eventId: destino.eventId,
        type: TIPO_CRONOGRAMA_RECORDATORIO,
      })
    } catch (error) {
      this.registro.warn(
        `Recordatorio guardado pero no empujado itemId=${job.itemId}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  private async campana(job: JobCampana): Promise<void> {
    for (const userId of job.userIds) {
      await this.tiempoReal.emitirAUsuario(userId, NOTIFICACION_CREADA, {
        eventId: job.eventId,
        type: job.tipo,
      })
    }
  }
}
