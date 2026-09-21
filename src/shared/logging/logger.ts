import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Options } from 'pino-http'

import type { Env } from '@/config/env.schema'
import { idDePeticion } from '@/shared/http/request-id.middleware'

import { CENSURA, RUTAS_REDACTADAS, urlParaRegistro } from './redaccion'

/** Lo que el serializador por defecto de pino deja en `req` (pino-std-serializers). */
interface ReqSerializada {
  id?: unknown
  method?: string | undefined
  url?: string | undefined
  headers?: Record<string, unknown> | undefined
  remoteAddress?: string | undefined
  remotePort?: number | undefined
}

/** Rutas de las sondas del orquestador: una línea cada pocos segundos por pod no aporta nada. */
const RUTAS_DE_SONDA = /^\/health(\/|\?|$)/

/**
 * Opciones de pino-http: el logger de las peticiones Y de Nest (`main.ts` hace
 * `app.useLogger` con él), así que todo lo que la app registra pasa por aquí.
 *
 * Redacción, en dos capas:
 *  - `serializers.req` reescribe la URL con `urlParaRegistro` (la MISMA función
 *    que usa `DomainExceptionFilter`) y descarta `params` y `query`: `params`
 *    lleva el token del RSVP en claro (`{ token: … }`) y `query` es texto libre
 *    del cliente. Método + URL tachada bastan para depurar.
 *  - `Referer` pasa por la misma `urlParaRegistro`: desde la página
 *    `${APP_URL}/rsvp/<token>` servida en el mismo origen que la API, cada
 *    llamada lo lleva con el token vivo en claro.
 *  - `x-original-uri` / `x-forwarded-uri` / `x-rewrite-url` pasan por la misma
 *    función: son las cabeceras que un proxy inverso (nginx `auth_request`,
 *    Traefik ForwardAuth) añade con la URL ORIGINAL de la petición —incluido
 *    el token del RSVP si esa era la ruta— antes de reescribirla hacia el
 *    backend.
 *  - `serializers.res` deja sólo el código de estado.
 *  - `redact` tacha las cabeceras con credenciales (ver `RUTAS_REDACTADAS`).
 */
export function opcionesDePinoHttp(env: Env): Options {
  return {
    level: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    redact: { paths: RUTAS_REDACTADAS, censor: CENSURA },
    serializers: {
      req: (req: ReqSerializada): ReqSerializada => ({
        id: req.id,
        method: req.method,
        url: urlParaRegistro(req.url),
        headers: cabecerasParaRegistro(req.headers),
        remoteAddress: req.remoteAddress,
        remotePort: req.remotePort,
      }),
      // Sólo el código: las cabeceras de respuesta son las mismas veinte de
      // helmet en cada línea, y entre ellas va el `Set-Cookie` del refresh
      // (que además está en `RUTAS_REDACTADAS`, por si esto cambia).
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
    // El mismo id que `RequestIdMiddleware` devuelve en `x-request-id`: la
    // línea del log y la respuesta que ve el cliente se pueden casar.
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const id = idDePeticion(req)
      res.setHeader('x-request-id', id)
      return id
    },
    autoLogging: {
      ignore: (req: IncomingMessage & { originalUrl?: string }) =>
        RUTAS_DE_SONDA.test(req.originalUrl ?? req.url ?? ''),
    },
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  }
}

/**
 * Cabeceras que llevan una URL completa y por tanto pasan por
 * `urlParaRegistro` en vez de registrarse tal cual: `referer` (ver arriba) y
 * las tres que añade un proxy inverso con la URL original de la petición.
 */
const CABECERAS_CON_URL = ['referer', 'x-original-uri', 'x-forwarded-uri', 'x-rewrite-url']

/**
 * Las cabeceras tal cual, salvo las de `CABECERAS_CON_URL`, que se tachan como
 * la URL. Una que no sea texto (Node la da siempre como string; esto es por
 * si cambia) se descarta en vez de registrarse sin tachar.
 */
function cabecerasParaRegistro(
  cabeceras: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (cabeceras === undefined) return cabeceras
  let resultado = cabeceras
  for (const nombre of CABECERAS_CON_URL) {
    if (!(nombre in resultado)) continue
    const { [nombre]: valor, ...resto } = resultado
    resultado = typeof valor === 'string' ? { ...resto, [nombre]: urlParaRegistro(valor) } : resto
  }
  return resultado
}
