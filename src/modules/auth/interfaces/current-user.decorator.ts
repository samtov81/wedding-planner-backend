import { createParamDecorator, type ExecutionContext } from '@nestjs/common'

import type { SystemRole } from '@/modules/users/domain/user'

export interface UsuarioAutenticado {
  id: string
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
