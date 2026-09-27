import { createParamDecorator, type ExecutionContext } from '@nestjs/common'

import type { EventAccess } from '../domain/event-access'

interface PeticionConAcceso {
  eventAccess?: EventAccess
}

/**
 * Inyecta el `EventAccess` que `EventAccessGuard` ya resolvió. Devuelve
 * `undefined` si la ruta no pasa por el guard: es opcional a propósito, para
 * que olvidarse del guard se vea en el tipo en vez de mentir con un acceso
 * que nadie ha comprobado.
 */
export const EventAccessOf = createParamDecorator(
  (_datos: unknown, ctx: ExecutionContext): EventAccess | undefined =>
    ctx.switchToHttp().getRequest<PeticionConAcceso>().eventAccess,
)
