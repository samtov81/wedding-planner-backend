import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Logger } from 'nestjs-pino'

import { AppModule } from './app.module'
import { ENV } from './config/config.module'
import type { Env } from './config/env.schema'
import { configurarApp, OPCIONES_DE_FABRICA } from './configurar-app'

async function bootstrap(): Promise<void> {
  // `bufferLogs`: lo que Nest registre mientras construye los módulos espera a
  // que pino esté puesto, en vez de salir por la consola en otro formato.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...OPCIONES_DE_FABRICA,
    bufferLogs: true,
  })
  app.useLogger(app.get(Logger))
  const env = app.get<Env>(ENV)

  // Al recibir SIGTERM (el orquestador parando el pod) cierra Prisma, Redis,
  // los workers de BullMQ y los sockets antes de salir, en vez de cortar los
  // trabajos a medias.
  app.enableShutdownHooks()

  await configurarApp(app, env)
  await app.listen(env.PORT)
}

bootstrap().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
