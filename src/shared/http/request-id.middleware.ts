import { randomUUID } from 'node:crypto'

import { Injectable, type NestMiddleware } from '@nestjs/common'

/**
 * Un identificador por petición, propagado a los logs y al payload de los jobs
 * (Tarea 6). Es lo que permite seguir "esta petición" desde el HTTP hasta el
 * correo que acabó produciendo, tres procesos más allá.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(
    req: { headers: Record<string, string | string[] | undefined>; requestId?: string },
    res: { setHeader: (k: string, v: string) => void },
    next: () => void,
  ): void {
    const entrante = req.headers['x-request-id']
    const id = typeof entrante === 'string' && entrante.length > 0 ? entrante : randomUUID()

    req.requestId = id
    res.setHeader('x-request-id', id)
    next()
  }
}
