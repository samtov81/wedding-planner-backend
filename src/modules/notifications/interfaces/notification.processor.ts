import { Processor, WorkerHost } from '@nestjs/bullmq'
import { UnrecoverableError, type Job } from 'bullmq'
import { z } from 'zod'

import {
  type JobEstadoInvitacion,
  TIPO_ESTADO_INVITACION,
} from '@/modules/guests/application/handle-delivery-event.use-case'
import {
  type JobAvisoRsvp,
  TIPO_RSVP_ACTUALIZADO,
} from '@/modules/guests/application/submit-rsvp.use-case'
import type { QueueName } from '@/modules/queue/application/queue.port'

import { BroadcastNoticeUseCase } from '../application/broadcast-notice.use-case'

/**
 * La cola es de ESTE módulo (ruling C17): sólo la llenan productores que avisan
 * en tiempo real, y sólo la consume este worker.
 */
export const COLA_NOTIFICACIONES = 'notifications' satisfies QueueName

/**
 * Lo que sale de Redis es ENTRADA: lo escribió otro proceso, quizá con otra
 * versión del código. Se valida, y se emite lo VALIDADO —`z.object` descarta
 * las claves que no declara—, así que un campo de más en Redis no llega nunca
 * a un socket. `satisfies` ata cada esquema al tipo que exporta su productor:
 * si el productor cambia la forma, esto deja de compilar.
 */
const avisoRsvpSchema = z.object({
  eventId: z.guid(),
  payload: z.object({
    guestId: z.guid(),
    guestName: z.string(),
    rsvp: z.enum(['CONFIRMED', 'DECLINED']),
  }),
}) satisfies z.ZodType<JobAvisoRsvp>

const estadoInvitacionSchema = z.object({
  eventId: z.guid(),
  payload: z.object({
    guestId: z.guid(),
    invitationId: z.guid(),
    status: z.enum(['DELIVERED', 'BOUNCED', 'COMPLAINED']),
  }),
}) satisfies z.ZodType<JobEstadoInvitacion>

function leer<T>(esquema: z.ZodType<T>, job: Job): T {
  const leido = esquema.safeParse(job.data)
  // Un payload roto no lo arregla ningún reintento: a fallidos, sin cinco
  // intentos inútiles. El mensaje no lleva el payload (no se registran datos
  // de invitados en los fallidos).
  if (!leido.success) throw new UnrecoverableError(`Payload inválido en el job ${job.name}`)
  return leido.data
}

/**
 * Worker de la cola `notifications`: el fan-out en tiempo real (ruling C23).
 * Vive en `interfaces/` como un controlador: es la puerta de la cola, no una
 * regla de negocio.
 *
 * Un nombre de job DESCONOCIDO es un bug y falla a la vista con
 * `UnrecoverableError` (lección de la Tarea 12): en BullMQ, un worker que toma
 * un job y retorna lo marca COMPLETADO, sin forma de devolverlo, así que
 * "ignorar lo que no es mío" borraría en silencio los avisos de un productor
 * nuevo que nadie ha enseñado a este worker.
 *
 * Los errores de emisión SALEN (ver `BroadcastNoticeUseCase`): así BullMQ
 * reintenta con la política común (5 intentos, backoff exponencial).
 */
@Processor(COLA_NOTIFICACIONES)
export class NotificationProcessor extends WorkerHost {
  constructor(private readonly avisos: BroadcastNoticeUseCase) {
    super()
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case TIPO_RSVP_ACTUALIZADO: {
        const { eventId, payload } = leer(avisoRsvpSchema, job)
        await this.avisos.avisarDeNotificacion(eventId, TIPO_RSVP_ACTUALIZADO, payload)
        return
      }
      case TIPO_ESTADO_INVITACION: {
        const { eventId, payload } = leer(estadoInvitacionSchema, job)
        await this.avisos.avisarDeCambio(eventId, TIPO_ESTADO_INVITACION, payload)
        return
      }
      default:
        throw new UnrecoverableError(`Job desconocido en la cola notifications: ${job.name}`)
    }
  }
}
