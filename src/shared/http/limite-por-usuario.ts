import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import {
  InjectThrottlerStorage,
  ThrottlerException,
  type ThrottlerStorage,
} from '@nestjs/throttler'

import { UnauthorizedError } from '@/shared/domain'

/**
 * Límite de ritmo POR USUARIO autenticado, contado en el mismo Redis que el
 * resto (`ThrottlerStorage`, ver `app.module.ts`).
 *
 * Por qué existe: `ThrottlerGuard` es `APP_GUARD` y corre ANTES que
 * `JwtAuthGuard`, así que cuando cuenta aún no hay `req.user` y sólo puede
 * contar por IP (el DESIGN-GAP de `vendor-catalog`, `invite` y `messages` en
 * `limitadores.ts`). Este guard va en la ruta, DETRÁS del `JwtAuthGuard` del
 * controlador (los guards de clase corren antes que los de método), y cuenta
 * por `req.user.id`. Alternativa descartada: un tracker propio dentro del
 * throttler global; seguiría ejecutándose antes de la autenticación.
 *
 * Sin `req.user` falla CERRADO con 401: usarlo sin `JwtAuthGuard` delante es un
 * error de cableado, y contar por "anónimo" daría un cupo compartido por todos.
 * Cuenta toda petición que llega, también las que luego fallan con 404/409/422
 * (decisión de la spec: el cupo es de intentos, no de éxitos).
 *
 * `shared/` no importa módulos: el tipo del usuario es local.
 *
 * Quien quiera migrar `messages`/`invite` a por-usuario: pasar de
 * `@LimiteDeRuta` a `@LimitePorUsuario` y quitar su entrada de `limitadores.ts`.
 */
export const LIMITE_CONTACT_REQUESTS = 'contact-requests'

const CLAVE = 'limite-por-usuario'

interface ConfiguracionDeLimite {
  nombre: string
  limit: number
  ttl: number
}

interface PeticionConUsuario {
  user?: { id: string }
}

@Injectable()
export class LimitePorUsuarioGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage() private readonly almacen: ThrottlerStorage,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const peticion = contexto.switchToHttp().getRequest<PeticionConUsuario>()
    const id = peticion.user?.id
    if (id === undefined) throw new UnauthorizedError('Falta el token de acceso')

    const config = this.reflector.get<ConfiguracionDeLimite | undefined>(
      CLAVE,
      contexto.getHandler(),
    )
    // Sin configuración no hay nada que limitar (guard puesto a mano sin decorador).
    if (config === undefined) return true

    const registro = await this.almacen.increment(
      `usuario:${id}`,
      config.ttl,
      config.limit,
      config.ttl,
      config.nombre,
    )
    if (registro.isBlocked) throw new ThrottlerException()
    return true
  }
}

/** Limita la ruta a `limit` peticiones por `ttl` ms y por usuario autenticado. */
export function LimitePorUsuario(
  nombre: string,
  opciones: { limit: number; ttl: number },
): MethodDecorator {
  return applyDecorators(
    SetMetadata(CLAVE, { nombre, ...opciones } satisfies ConfiguracionDeLimite),
    UseGuards(LimitePorUsuarioGuard),
  )
}
