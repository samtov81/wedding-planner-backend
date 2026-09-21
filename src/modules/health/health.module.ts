import { Module } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { PrismaService } from '@/modules/database/prisma.service'

import { COMPROBACIONES, type Comprobacion } from './application/comprobacion.port'
import { PrismaComprobacion } from './infrastructure/prisma.comprobacion'
import { RedisComprobacion } from './infrastructure/redis.comprobacion'
import { HealthController } from './interfaces/health.controller'

/**
 * `/health` (liveness) y `/health/ready` (readiness). Redis se comprueba
 * porque de él dependen los límites de ritmo (el guard los cuenta ahí en cada
 * petición), las colas y el tiempo real: un pod sin Redis no debe recibir
 * tráfico.
 */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: PrismaComprobacion,
      inject: [PrismaService],
      useFactory: (p: PrismaService) => new PrismaComprobacion(p),
    },
    {
      provide: RedisComprobacion,
      inject: [ENV],
      useFactory: (env: Env) => new RedisComprobacion(env.REDIS_URL),
    },
    {
      provide: COMPROBACIONES,
      inject: [PrismaComprobacion, RedisComprobacion],
      useFactory: (...comprobaciones: Comprobacion[]) => comprobaciones,
    },
  ],
})
export class HealthModule {}
