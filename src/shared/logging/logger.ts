import pino, { type Logger } from 'pino'

import type { Env } from '@/config/env.schema'

/**
 * Los campos redactados no son una lista de cortesía: un log con el header
 * Authorization convierte el sistema de logs en un almacén de credenciales, y
 * los logs se retienen, se exportan y se comparten con más gente que la base
 * de datos.
 */
export function crearLogger(env: Env): Logger {
  return pino({
    level: env.NODE_ENV === 'test' ? 'silent' : 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.tokenHash',
        '*.refreshToken',
      ],
      censor: '[REDACTADO]',
    },
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  })
}
