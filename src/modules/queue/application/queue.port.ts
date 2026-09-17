export type QueueName = 'email' | 'notifications' | 'maintenance'

export interface EnqueueOptions {
  /**
   * Identificador determinista del trabajo, derivado de la entidad que lo
   * origina (`invitation:<id>`). Es lo que hace idempotente el encolado: sin
   * él, reintentar una petición produce un segundo correo.
   */
  jobId: string
  delayMs?: number
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
