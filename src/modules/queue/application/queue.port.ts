/**
 * `invitations` tiene cola PROPIA (ruling C17): en BullMQ un worker que toma un
 * job y retorna lo marca completado, así que un worker sobre una cola compartida
 * se come los jobs de los demás productores. Cada tipo con worker propio, su cola.
 */
export type QueueName = 'email' | 'invitations' | 'notifications' | 'maintenance'

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
   * Edad por encima de la cual BullMQ PUEDE recortar los fallidos. NO es una
   * cota: el recorte sólo corre cuando OTRO job de la misma cola con esta opción
   * falla definitivamente, así que el último lote de fallidos se queda sin
   * límite hasta que falle otro. Sin ella, los fallidos no se recortan nunca.
   * Un secreto en el payload necesita además invalidarse en origen.
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
