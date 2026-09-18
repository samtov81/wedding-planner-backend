export type QueueName = 'email' | 'notifications' | 'maintenance'

export interface EnqueueOptions {
  /**
   * Identificador determinista del trabajo, derivado de la entidad que lo
   * origina (`invitation-<id>`). NUNCA con `:` —BullMQ lo usa como separador de
   * claves de Redis y rechaza el job ("Custom Id cannot contain :"); costó un
   * 500 en la Tarea 8—. Encolar dos veces el MISMO jobId deja un solo job, así
   * que la idempotencia sólo es real si la entidad de la que se deriva es la
   * misma entre reintentos: un id recién generado en cada llamada no deduplica
   * nada.
   */
  jobId: string
  delayMs?: number
  /**
   * Borrar el job de Redis en cuanto completa. Obligatorio si el payload lleva
   * un secreto (un token en claro): la política común conserva los completados
   * 24 h.
   */
  removeOnComplete?: true
  /**
   * Edad máxima de un job fallido definitivo en Redis. Sin ella, los fallidos se
   * conservan SIN LÍMITE (la política común no los borra), con su payload.
   */
  removeOnFailAfterMs?: number
}

export interface QueuePort {
  enqueue<T extends object>(
    cola: QueueName,
    nombre: string,
    datos: T,
    opciones: EnqueueOptions,
  ): Promise<void>
}

export const QUEUE_PORT = Symbol('QUEUE_PORT')
