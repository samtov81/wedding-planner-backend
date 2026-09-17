import { createParamDecorator, type ExecutionContext } from '@nestjs/common'

import type { SystemRole } from '@/modules/users/domain/user'

/**
 * Lo que `JwtAuthGuard` deja en `req.user`: el usuario RECARGADO de la base de
 * datos, no lo que venía firmado en el token. Lleva email y nombre porque
 * `GET /auth/me` con sólo `{ id, systemRole }` no le sirve de nada al frontend.
 */
export interface UsuarioAutenticado {
  id: string
  email: string
  fullName: string
  systemRole: SystemRole
}

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
