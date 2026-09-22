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

  try {
    await configurarApp(app, env)
    await app.listen(env.PORT)
  } catch (error) {
    // Cuando `listen` falla, la aplicación YA ESTÁ construida y viva: sus
    // workers de BullMQ están consumiendo las colas y Prisma y Redis tienen
    // conexiones abiertas. Sin este cierre el proceso no termina —esos handles
    // mantienen vivo el bucle de eventos— y se queda de WORKER FANTASMA:
    // invisible (no escucha en ningún puerto) pero robándole los jobs al
    // proceso que sí arrancó, y ejecutándolos con el código de ESTE build.
    // En desarrollo, donde el `EADDRINUSE` de un `npm run dev` repetido es
    // rutina, eso se traduce en jobs procesados por una versión vieja mientras
    // se depura la nueva. Cerrar antes de propagar el error lo evita.
    await app.close()
    throw error
  }
}

bootstrap().catch((error: unknown) => {
  console.error(error)
  // `process.exitCode` a secas NO basta: sólo fija el código con el que el
  // proceso saldrá *cuando* salga, y basta un handle vivo para que no salga
  // nunca. El `app.close()` de arriba debería haberlos soltado todos, pero un
  // arranque fallido no puede depender de eso: lo que no arrancó, termina.
  process.exit(1)
})
