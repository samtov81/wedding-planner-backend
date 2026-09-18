import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'

import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'
import { UnauthorizedError } from '@/shared/domain'

import {
  ACCESS_TOKEN_RECHAZADO,
  autenticarAccessToken,
  type UsuarioAutenticado,
} from '../application/autenticar-access-token'
import { TokenService } from '../application/token.service'

interface RequestConAuth {
  headers: { authorization?: string }
  user?: UsuarioAutenticado
}

/**
 * Verifica `Authorization: Bearer <accessToken>`, RECARGA el usuario y lo deja
 * en `req.user`. El access token es un JWT normal (no opaco, a diferencia del
 * refresh): no se revoca, sólo caduca — para eso vive 15 minutos.
 *
 * Qué se comprueba (firma, rol dentro de `SystemRole`, usuario que sigue
 * existiendo) vive en `autenticarAccessToken`, que es el MISMO código que
 * autentica los sockets (Tarea 15). Aquí sólo queda lo que es de HTTP: leer la
 * cabecera y responder con la excepción de Nest.
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

    try {
      req.user = await autenticarAccessToken(
        this.tokens,
        this.usuarios,
        cabecera.slice('Bearer '.length),
      )
    } catch (error) {
      // SÓLO el rechazo del token es un 401. Un fallo al recargar el usuario
      // (la base de datos caída) sale tal cual y el filtro lo responde como
      // 500: convertirlo en 401 haría que, durante una caída, cada petición
      // dijera "token caducado", los clientes cerraran la sesión y la caída no
      // se viera. Mismo criterio que el gateway (`conSalaAutorizada`).
      if (error instanceof UnauthorizedError) {
        throw new UnauthorizedException(ACCESS_TOKEN_RECHAZADO)
      }
      throw error
    }
    return true
  }
}
