import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'

import { TokenService } from '../application/token.service'
import type { UsuarioAutenticado } from './current-user.decorator'

interface RequestConAuth {
  headers: { authorization?: string }
  user?: UsuarioAutenticado
}

/**
 * Verifica `Authorization: Bearer <accessToken>` y deja `{ id, systemRole }`
 * en `req.user`. El access token es un JWT normal (no opaco, a diferencia del
 * refresh): no se revoca, sólo caduca — para eso vive 15 minutos.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestConAuth>()
    const cabecera = req.headers.authorization

    if (cabecera === undefined || !cabecera.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el token de acceso')
    }

    const token = cabecera.slice('Bearer '.length)

    try {
      const payload = this.tokens.verificarAccess(token)
      req.user = { id: payload.sub, systemRole: payload.role as UsuarioAutenticado['systemRole'] }
      return true
    } catch {
      throw new UnauthorizedException('Token de acceso inválido o caducado')
    }
  }
}
