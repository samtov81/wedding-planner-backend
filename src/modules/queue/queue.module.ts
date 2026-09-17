import { Global, Module } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import { QUEUE_PORT } from './application/queue.port'
import { BullmqQueueAdapter } from './infrastructure/bullmq-queue.adapter'

@Global()
@Module({
  providers: [
    { provide: QUEUE_PORT, inject: [ENV], useFactory: (env: Env) => new BullmqQueueAdapter(env) },
  ],
  exports: [QUEUE_PORT],
})
export class QueueModule {}
