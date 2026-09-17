import { Global, Module } from '@nestjs/common'

import { loadEnv } from './env'
import type { Env } from './env.schema'

/** Token de inyección del entorno. Nadie lee `process.env` fuera de aquí. */
export const ENV = Symbol('ENV')

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv(process.env) }],
  exports: [ENV],
})
export class ConfigModule {}
