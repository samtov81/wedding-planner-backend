import { randomUUID } from 'node:crypto'

import { Injectable, type NestMiddleware } from '@nestjs/common'

interface PeticionConId {
  headers: Record<string, string | string[] | undefined>
  requestId?: string
}

/**
 * Forma aceptable de un `x-request-id` entrante: lo que generan los proxies y
 * los clientes habituales (UUID, ids hex, `trazable-1`…).
 *
 * DESIGN-GAP: el brief propaga la cabecera tal cual. Pero el id se escribe en
 * cada línea de log y en el cuerpo de cada error: sin acotarlo, un cliente mete
 * megas de texto o JSON que imita otras líneas en el sistema de logs. Lo que no
 * casa se sustituye por un UUID propio (no se rechaza la petición: el id es
 * para trazar, no una entrada de la API).
 */
const FORMATO_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * El id de ESTA petición, calculado una sola vez. Lo llaman el middleware y
 * pino-http (`genReqId`), cada uno desde su sitio de la cadena: sea cual sea el
 * orden en que Nest monte los dos, ambos ven el mismo id.
 */
export function idDePeticion(req: PeticionConId): string {
  if (req.requestId !== undefined) return req.requestId

  const entrante = req.headers['x-request-id']
  const id =
    typeof entrante === 'string' && FORMATO_REQUEST_ID.test(entrante) ? entrante : randomUUID()
  req.requestId = id
  return id
}

/**
 * Un identificador por petición, propagado a los logs y al payload de los jobs
 * (Tarea 6). Es lo que permite seguir "esta petición" desde el HTTP hasta el
 * correo que acabó produciendo, tres procesos más allá.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(
    req: PeticionConId,
    res: { setHeader: (k: string, v: string) => void },
    next: () => void,
  ): void {
    res.setHeader('x-request-id', idDePeticion(req))
    next()
  }
}
