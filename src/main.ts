import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'
import cookieParser from 'cookie-parser'

import { AppModule } from './app.module'
import { ENV } from './config/config.module'
import type { Env } from './config/env.schema'
import { DomainExceptionFilter } from './shared/http/domain-exception.filter'

async function bootstrap(): Promise<void> {
  // `rawBody: true` NO cambia el parseo de JSON de ninguna ruta: Nest sigue
  // poniendo `req.body` como siempre y, además, guarda los bytes originales en
  // `req.rawBody`. El webhook de Resend (`POST /webhooks/resend`) los necesita
  // porque la firma Svix cubre los bytes exactos, y re-serializar `req.body` no
  // los reproduce. Coste: una copia del cuerpo por petición JSON, acotada por el
  // límite de tamaño del parser (100 kB por defecto).
  const app = await NestFactory.create(AppModule, { rawBody: true })
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
