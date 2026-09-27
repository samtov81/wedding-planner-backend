import { BullModule } from '@nestjs/bullmq'
import { Global, Module } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import { QUEUE_PORT } from './application/queue.port'
import { BullmqQueueAdapter } from './infrastructure/bullmq-queue.adapter'

/**
 * `BullModule.forRootAsync` registra la CONEXIÓN compartida que usan los
 * workers de `@Processor` (Tarea 12). El puerto `QUEUE_PORT` sigue siendo la
 * única vía de ENCOLAR —los casos de uso no conocen BullMQ—; `BullModule` sólo
 * aporta el lado consumidor, que necesita el explorador de Nest para montar los
 * `Worker` y cerrarlos al apagar la aplicación.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ connection: { url: env.REDIS_URL } }),
    }),
  ],
  providers: [
    { provide: QUEUE_PORT, inject: [ENV], useFactory: (env: Env) => new BullmqQueueAdapter(env) },
  ],
  exports: [QUEUE_PORT],
})
export class QueueModule {}
