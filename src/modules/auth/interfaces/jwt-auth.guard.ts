import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'

import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'
import type { SystemRole } from '@/modules/users/domain/user'

import { TokenService } from '../application/token.service'
import type { UsuarioAutenticado } from './current-user.decorator'

interface RequestConAuth {
  headers: { authorization?: string }
  user?: UsuarioAutenticado
}

/**
 * Catálogo de roles válidos como `Record<SystemRole, true>`: si mañana la
 * unión gana un valor, esto deja de compilar y hay que decidir qué hacer con
 * él, en vez de rechazarlo en silencio.
 */
const ROLES_VALIDOS: Record<SystemRole, true> = { USER: true, ADMIN: true }

function esSystemRole(valor: string): valor is SystemRole {
  return Object.hasOwn(ROLES_VALIDOS, valor)
}

/**
 * Verifica `Authorization: Bearer <accessToken>`, RECARGA el usuario y lo deja
 * en `req.user`. El access token es un JWT normal (no opaco, a diferencia del
 * refresh): no se revoca, sólo caduca — para eso vive 15 minutos.
 *
 * Se recarga el usuario en vez de confiar en los claims porque un usuario
 * borrado, o degradado de ADMIN a USER, conservaría acceso completo durante lo
 * que quedara del TTL. El `role` del token se valida igualmente contra
 * `SystemRole`: `verificarAccess` hace `String(payload.role)`, así que un token
 * acuñado sin ese claim produciría la cadena literal `'undefined'` tipada como
 * rol. La fuente de verdad del rol es la fila del usuario, no el token.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestConAuth>()
    const cabecera = req.headers.authorization

    if (cabecera === undefined || !cabecera.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el token de acceso')
    }

    const token = cabecera.slice('Bearer '.length)

    let sub: string
    try {
      const payload = this.tokens.verificarAccess(token)
      if (!esSystemRole(payload.role)) {
        throw new UnauthorizedException('Token de acceso inválido o caducado')
      }
      sub = payload.sub
    } catch {
      throw new UnauthorizedException('Token de acceso inválido o caducado')
    }

    const usuario = await this.usuarios.findById(sub)
    if (usuario === null) throw new UnauthorizedException('Token de acceso inválido o caducado')

    req.user = {
      id: usuario.id,
      email: usuario.email,
      fullName: usuario.fullName,
      systemRole: usuario.systemRole,
    }
    return true
  }
}
