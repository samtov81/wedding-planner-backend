import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { Queue } from 'bullmq'

import { ENV } from '@/config/config.module'

import type { EnqueueOptions, QueueName, QueuePort } from '../application/queue.port'

/**
 * Política común de todos los jobs.
 *
 * `attempts: 5` con backoff exponencial desde 2s cubre las caídas cortas de un
 * proveedor sin martillearlo. `removeOnComplete` acotado evita que Redis crezca
 * sin límite; `removeOnFail: false` conserva los fallidos permanentes, que es
 * de donde sale la cola muerta y la alerta.
 */
export const OPCIONES_POR_DEFECTO = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: false,
}

@Injectable()
export class BullmqQueueAdapter implements QueuePort, OnModuleDestroy {
  private readonly colas = new Map<QueueName, Queue>()

  constructor(@Inject(ENV) private readonly env: { REDIS_URL: string }) {}

  private obtener(nombre: QueueName): Queue {
    const existente = this.colas.get(nombre)
    if (existente !== undefined) return existente

    const cola = new Queue(nombre, { connection: { url: this.env.REDIS_URL } })
    this.colas.set(nombre, cola)
    return cola
  }

  async enqueue<T extends object>(
    cola: QueueName,
    nombre: string,
    datos: T,
    opciones: EnqueueOptions,
  ): Promise<void> {
    await this.obtener(cola).add(nombre, datos, {
      ...OPCIONES_POR_DEFECTO,
      jobId: opciones.jobId,
      ...(opciones.delayMs !== undefined ? { delay: opciones.delayMs } : {}),
      ...(opciones.removeOnComplete === true ? { removeOnComplete: true } : {}),
      // BullMQ mide la edad en SEGUNDOS; el puerto, como `delayMs`, en ms.
      // Ojo: la limpieza por edad es perezosa —BullMQ la aplica cuando otro job
      // termina o falla—, así que la edad es un mínimo, no una hora exacta.
      ...(opciones.removeOnFailAfterMs !== undefined
        ? { removeOnFail: { age: Math.ceil(opciones.removeOnFailAfterMs / 1_000) } }
        : {}),
    })
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.colas.values()].map((cola) => cola.close()))
  }
}
