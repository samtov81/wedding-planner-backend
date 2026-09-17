import { Injectable } from '@nestjs/common'

import type { EnqueueOptions, QueueName, QueuePort } from '../application/queue.port'

interface Encolado {
  cola: QueueName
  nombre: string
  datos: unknown
  jobId: string
}

/**
 * Doble para los tests de casos de uso: permite assertar QUÉ se encoló sin
 * levantar Redis. Replica la deduplicación por jobId, que es la propiedad de
 * la que dependen los casos de uso.
 */
@Injectable()
export class InMemoryQueueAdapter implements QueuePort {
  readonly encolados: Encolado[] = []

  enqueue<T extends object>(
    cola: QueueName,
    nombre: string,
    datos: T,
    opciones: EnqueueOptions,
  ): Promise<void> {
    if (!this.encolados.some((e) => e.jobId === opciones.jobId)) {
      this.encolados.push({ cola, nombre, datos, jobId: opciones.jobId })
    }
    return Promise.resolve()
  }
}
