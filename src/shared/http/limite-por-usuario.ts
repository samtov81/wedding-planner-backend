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
 * Sin metadatos (el guard puesto con `@UseGuards` a mano, sin
 * `@LimitePorUsuario`) también falla CERRADO, con un `Error` de programación
 * (500): una ruta que alguien quiso limitar no debe quedar sin límite por un
 * cableado a medias. Alternativa descartada: dejar pasar y documentarlo, que
 * convierte el olvido en una ruta abierta que ningún test señala.
 *
 * Al cortar envía DOS cabeceras con los segundos que faltan
 * (`timeToBlockExpire`, o `timeToExpire` si el almacén no da bloqueo; los dos
 * ya en segundos en `ThrottlerStorageRedisService`): `Retry-After` y
 * `Retry-After-<nombre>` (aquí `Retry-After-contact-requests`). `ThrottlerGuard`
 * envía SÓLO `Retry-After-<nombre>` para un limitador con nombre (p. ej.
 * `Retry-After-global`, `Retry-After-vendor-profile`) y `Retry-After` a secas
 * sólo para el `default`, que aquí no existe. La de sufijo mantiene la
 * convención de esta API para saber QUÉ límite cortó; la estándar es la que
 * entiende cualquier cliente HTTP.
 *
 * `shared/` no importa módulos: el tipo del usuario es local.
 *
 * `porParametro` (opcional) parte además el cupo por un parámetro de ruta:
 * `schedule-notify` cuenta por usuario Y evento (`eventId`), como pide la spec
 * 2026-11-10 §6 ("5 por hora por evento"), así que un planner con dos bodas
 * tiene un cupo en cada una. Si la ruta no trae ese parámetro falla CERRADO
 * con un `Error` de programación, por lo mismo que sin metadatos: contar bajo
 * "sin evento" juntaría en un cupo lo que debía ir separado.
 *
 * Quien quiera migrar `messages`/`invite` a por-usuario: pasar de
 * `@LimiteDeRuta` a `@LimitePorUsuario` y quitar su entrada de `limitadores.ts`.
 */
export const LIMITE_CONTACT_REQUESTS = 'contact-requests'
/** "Notify Vendors" del cronograma: 5 por hora por usuario y evento (spec 2026-11-10 §6). */
export const LIMITE_SCHEDULE_NOTIFY = 'schedule-notify'

const CLAVE = 'limite-por-usuario'

interface ConfiguracionDeLimite {
  nombre: string
  limit: number
  ttl: number
  porParametro?: string | undefined
}

interface PeticionConUsuario {
  user?: { id: string }
  params?: Record<string, string | undefined>
}

/** Lo único que el guard usa de la respuesta de Express (lo mismo que `ThrottlerGuard`). */
interface RespuestaConCabeceras {
  header(nombre: string, valor: number): unknown
}

@Injectable()
export class LimitePorUsuarioGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage() private readonly almacen: ThrottlerStorage,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const config = this.reflector.get<ConfiguracionDeLimite | undefined>(
      CLAVE,
      contexto.getHandler(),
    )
    if (config === undefined) {
      throw new Error('LimitePorUsuarioGuard sin @LimitePorUsuario: usa el decorador, no el guard')
    }
    const http = contexto.switchToHttp()
    const peticion = http.getRequest<PeticionConUsuario>()
    const id = peticion.user?.id
    if (id === undefined) throw new UnauthorizedError('Falta el token de acceso')

    let clave = `usuario:${id}`
    if (config.porParametro !== undefined) {
      const valor = new Map(Object.entries(peticion.params ?? {})).get(config.porParametro)
      if (valor === undefined) {
        throw new Error(`@LimitePorUsuario: la ruta no tiene el parámetro ${config.porParametro}`)
      }
      clave += `:${config.porParametro}:${valor}`
    }

    const registro = await this.almacen.increment(
      clave,
      config.ttl,
      config.limit,
      config.ttl,
      config.nombre,
    )
    if (registro.isBlocked) {
      const segundos =
        registro.timeToBlockExpire > 0 ? registro.timeToBlockExpire : registro.timeToExpire
      const respuesta = http.getResponse<RespuestaConCabeceras>()
      respuesta.header('Retry-After', segundos)
      respuesta.header(`Retry-After-${config.nombre}`, segundos)
      throw new ThrottlerException()
    }
    return true
  }
}

/**
 * Limita la ruta a `limit` peticiones por `ttl` ms y por usuario autenticado
 * (y por el valor de `porParametro`, si se da).
 */
export function LimitePorUsuario(
  nombre: string,
  opciones: { limit: number; ttl: number; porParametro?: string },
): MethodDecorator {
  return applyDecorators(
    SetMetadata(CLAVE, { nombre, ...opciones } satisfies ConfiguracionDeLimite),
    UseGuards(LimitePorUsuarioGuard),
  )
}
