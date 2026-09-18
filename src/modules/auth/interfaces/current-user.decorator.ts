import { createParamDecorator, type ExecutionContext } from '@nestjs/common'

import type { UsuarioAutenticado } from '../application/autenticar-access-token'

/**
 * Lo que `JwtAuthGuard` deja en `req.user`. Se define junto a
 * `autenticarAccessToken` (application/), que es quien lo produce; se
 * re-exporta aquí porque los controladores lo importan de este fichero.
 */
export type { UsuarioAutenticado }

interface RequestConUsuario {
  user?: UsuarioAutenticado
}

/** Inyecta el usuario que `JwtAuthGuard` dejó en `req.user`, ya tipado. */
export const CurrentUser = createParamDecorator(
  (_datos: unknown, ctx: ExecutionContext): UsuarioAutenticado | undefined => {
    const req = ctx.switchToHttp().getRequest<RequestConUsuario>()
    return req.user
  },
)
