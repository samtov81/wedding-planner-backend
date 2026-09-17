import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module'
import { ENV } from './config/config.module'
import type { Env } from './config/env.schema'
import { DomainExceptionFilter } from './shared/http/domain-exception.filter'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  const env = app.get<Env>(ENV)

  app.useGlobalFilters(new DomainExceptionFilter())

  await app.listen(env.PORT)
}

bootstrap().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
