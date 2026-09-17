import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'
import cookieParser from 'cookie-parser'

import { AppModule } from './app.module'
import { ENV } from './config/config.module'
import type { Env } from './config/env.schema'
import { DomainExceptionFilter } from './shared/http/domain-exception.filter'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  const env = app.get<Env>(ENV)

  // El refresh token viaja en una cookie httpOnly (nunca en el cuerpo ni en
  // localStorage): necesita el parser para que `req.cookies` exista.
  app.use(cookieParser())
  app.useGlobalFilters(new DomainExceptionFilter())

  await app.listen(env.PORT)
}

bootstrap().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
