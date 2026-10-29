import type { Logger } from '@nestjs/common'

import type { QueueName, QueuePort } from '@/modules/queue/application/queue.port'

/**
 * Contrato de los avisos en tiempo real de la mensajería (spec 2026-10-29 §5.1).
 * Lo PRODUCEN los casos de uso de enviar y marcar; lo consume
 * `interfaces/messaging.processor.ts`, que emite al socket de cada destinatario.
 *
 * Cola PROPIA, `messaging` (ruling C17, igual que `members`): un worker que toma
 * un job y retorna lo marca completado, así que compartir cola con otro worker
 * le comería los jobs.
 *
 * El job lleva sólo ids, NO el cuerpo ni las marcas. El worker lee el estado
 * ACTUAL del repositorio y comprueba por destinatario que aún puede ver la
 * conversación: un proveedor al que se le retiró el acceso entre el encolado y
 * el consumo no debe recibir el mensaje. Alternativa descartada: meter el
 * mensaje en el job, que emitiría una foto vieja y sin esa comprobación.
 *
 * El aviso es una optimización de latencia sobre un estado que ya está en la
 * base: se encola DESPUÉS de persistir y, si Redis falla, el destinatario lo ve
 * al recargar o reconectar. Por eso un fallo de encolado se registra y NO se
 * propaga.
 */
export const COLA_MENSAJERIA = 'messaging' satisfies QueueName

/** Nombres de job y, a la vez, de evento de socket. */
export const EVENTO_MENSAJE_CREADO = 'message.created'
export const EVENTO_MENSAJE_RECIBO = 'message.receipt'

export interface JobMensajeCreado {
  conversationId: string
  messageId: string
}

export interface JobRecibo {
  conversationId: string
  /** Quien marcó: sus marcas son las que se envían al otro participante. */
  userId: string
}

/** Único por mensaje: reencolarlo (un reintento del caso de uso) no duplica el aviso. */
export const jobIdDeMensaje = (messageId: string): string => `message-${messageId}`

/**
 * Único por MARCADO, no por par conversación/usuario: cada avance de la marca
 * es un aviso distinto y BullMQ descartaría los siguientes por jobId repetido.
 * Con `-`, nunca `:` (ver `EnqueueOptions.jobId`).
 */
export const jobIdDeRecibo = (conversationId: string, userId: string, en: Date): string =>
  `receipt-${conversationId}-${userId}-${en.getTime()}`

async function encolarSinPropagar(
  registro: Logger,
  que: string,
  conversationId: string,
  encolar: () => Promise<void>,
): Promise<void> {
  try {
    await encolar()
  } catch (error) {
    registro.warn(
      `${que} guardado pero su aviso no se pudo encolar conversationId=${conversationId}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }
}

/** Cuando se llama, el mensaje ya está confirmado: un fallo de Redis sólo se avisa. */
export function encolarAvisoMensaje(
  cola: QueuePort,
  registro: Logger,
  job: JobMensajeCreado,
): Promise<void> {
  return encolarSinPropagar(registro, 'Mensaje', job.conversationId, () =>
    cola.enqueue(COLA_MENSAJERIA, EVENTO_MENSAJE_CREADO, job, {
      jobId: jobIdDeMensaje(job.messageId),
    }),
  )
}

/** Cuando se llama, la marca ya está confirmada: un fallo de Redis sólo se avisa. */
export function encolarAvisoRecibo(
  cola: QueuePort,
  registro: Logger,
  job: JobRecibo,
): Promise<void> {
  return encolarSinPropagar(registro, 'Recibo', job.conversationId, () =>
    cola.enqueue(COLA_MENSAJERIA, EVENTO_MENSAJE_RECIBO, job, {
      jobId: jobIdDeRecibo(job.conversationId, job.userId, new Date()),
    }),
  )
}
