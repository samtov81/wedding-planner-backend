import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import { z } from 'zod'

import { REALTIME_PORT, type RealtimePort } from '@/modules/notifications/application/realtime.port'

import {
  COLA_MENSAJERIA,
  EVENTO_MENSAJE_CREADO,
  EVENTO_MENSAJE_RECIBO,
  type JobMensajeCreado,
  type JobRecibo,
} from '../application/avisos-mensajeria'
import {
  CONVERSATION_REPOSITORY,
  type ConversationRepository,
} from '../application/conversation.repository'
import { mensajeJson, otherMarksJson } from './messaging.json'

/**
 * Lo que sale de Redis es ENTRADA (lo escribió otro proceso, quizá con otra
 * versión): se valida y `satisfies` ata cada esquema al tipo que exporta el
 * productor, como en `NotificationProcessor`.
 */
const mensajeCreadoSchema = z.object({
  conversationId: z.guid(),
  messageId: z.guid(),
}) satisfies z.ZodType<JobMensajeCreado>

const reciboSchema = z.object({
  conversationId: z.guid(),
  userId: z.guid(),
}) satisfies z.ZodType<JobRecibo>

function leer<T>(esquema: z.ZodType<T>, job: Job): T {
  const leido = esquema.safeParse(job.data)
  // Un payload roto no lo arregla ningún reintento. El mensaje no lleva el
  // payload: no se registran mensajes de nadie en los fallidos.
  if (!leido.success) throw new UnrecoverableError(`Payload inválido en el job ${job.name}`)
  return leido.data
}

/**
 * Worker de la cola `messaging`: emite `message.created` y `message.receipt` a
 * la sala personal `user:<id>` de cada destinatario (spec 2026-10-29 §5.1).
 *
 * Lee el estado ACTUAL del repositorio, no del job, y para CADA destinatario
 * comprueba `buscar(conversationId, destinatario) !== null` justo antes de
 * emitir: si perdió el acceso entre el encolado y ahora (un proveedor
 * descontratado), no recibe nada. Alternativa descartada: confiar en la lista
 * de destinatarios del momento de enviar, que emitiría a quien ya no debe verlo.
 *
 * `message.created` se emite también al propio emisor (sala de su usuario),
 * para que sus OTRAS sesiones vean el mensaje; el frontend deduplica por
 * `message.id` y nunca cuenta como no leído un mensaje propio. `message.receipt`
 * va sólo a los demás: las otras sesiones de quien marca aún no reciben sus
 * propios recibos (parte 4).
 *
 * Un nombre de job DESCONOCIDO falla con `UnrecoverableError` (en BullMQ,
 * retornar marca el job completado y ignorarlo lo borraría en silencio). Los
 * errores de emisión SALEN, para que BullMQ reintente con la política común.
 */
@Processor(COLA_MENSAJERIA)
export class MessagingProcessor extends WorkerHost {
  constructor(
    @Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository,
    @Inject(REALTIME_PORT) private readonly tiempoReal: RealtimePort,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case EVENTO_MENSAJE_CREADO:
        await this.mensajeCreado(leer(mensajeCreadoSchema, job))
        return
      case EVENTO_MENSAJE_RECIBO:
        await this.recibo(leer(reciboSchema, job))
        return
      default:
        throw new UnrecoverableError(`Job desconocido en la cola messaging: ${job.name}`)
    }
  }

  private async mensajeCreado({ conversationId, messageId }: JobMensajeCreado): Promise<void> {
    const mensaje = await this.repo.mensaje(conversationId, messageId)
    if (mensaje === null) return
    const cuerpo = { conversationId, message: mensajeJson(mensaje) }
    for (const destinatario of await this.repo.participantes(conversationId)) {
      // También al emisor (sus otras sesiones), tras la misma comprobación.
      if ((await this.repo.buscar(conversationId, destinatario)) === null) continue
      await this.tiempoReal.emitirAUsuario(destinatario, EVENTO_MENSAJE_CREADO, cuerpo)
    }
  }

  private async recibo({ conversationId, userId }: JobRecibo): Promise<void> {
    for (const destinatario of await this.repo.participantes(conversationId)) {
      if (destinatario === userId) continue
      const vista = await this.repo.buscar(conversationId, destinatario)
      if (vista === null) continue
      // Desde la vista del destinatario, `otherMarks` son las marcas de quien
      // marcó: justo lo que hay que enseñarle, tal y como están ahora.
      await this.tiempoReal.emitirAUsuario(destinatario, EVENTO_MENSAJE_RECIBO, {
        conversationId,
        userId,
        ...otherMarksJson(vista.otherMarks),
      })
    }
  }
}
