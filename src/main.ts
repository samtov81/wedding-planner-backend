import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module'
import { ENV } from './config/config.module'
import type { Env } from './config/env.schema'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  const env = app.get<Env>(ENV)

  await app.listen(env.PORT)
}

bootstrap()
