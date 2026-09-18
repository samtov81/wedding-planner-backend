import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import type { DestinationStream } from 'pino'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import { opcionesDePinoHttp } from './logger'

/**
 * Adónde escribe pino. `null` = su destino por defecto (stdout, o el
 * transporte de pino-pretty en desarrollo). Existe para que un test pueda
 * capturar las líneas con `overrideProvider` y afirmar sobre lo que de verdad
 * se escribe, redacción incluida.
 */
export const DESTINO_DE_LOGS = Symbol('DESTINO_DE_LOGS')

/**
 * Logs estructurados con pino (Tareas 4 y 14): una línea JSON por petición con
 * su `x-request-id`, y el `Logger` de Nest encaminado al mismo pino desde
 * `main.ts`. La redacción vive en `opcionesDePinoHttp`.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      providers: [{ provide: DESTINO_DE_LOGS, useValue: null }],
      inject: [ENV, DESTINO_DE_LOGS],
      useFactory: (env: Env, destino: DestinationStream | null) => {
        const opciones = opcionesDePinoHttp(env)
        if (destino === null) return { pinoHttp: opciones }
        // pino no admite a la vez un transporte y un destino propio.
        const { transport: _transporte, ...sinTransporte } = opciones
        return { pinoHttp: [sinTransporte, destino] }
      },
    }),
  ],
})
export class RegistroModule {}
