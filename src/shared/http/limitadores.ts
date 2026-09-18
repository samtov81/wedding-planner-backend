import { applyDecorators, type ExecutionContext, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Throttle, type ThrottlerOptions } from '@nestjs/throttler'

/**
 * Límites de ritmo de la API, contados en Redis (ver `app.module.ts`).
 *
 * Dos clases de limitador (ruling C22):
 *  - `global`: 120/min por IP y por ruta, sobre TODA la API. Es el suelo que
 *    tienen las rutas sin sesión que no llevan límite propio —`POST
 *    /auth/register` (que enumera cuentas vía 409), `POST /auth/refresh`— y el
 *    que acota el password spraying desde una IP: el límite de login es por
 *    IP + correo, así que sin este suelo una IP tendría 5 intentos contra CADA
 *    correo.
 *  - con nombre (`rsvp`, `login`): SÓLO en las rutas que los piden con
 *    `@LimiteDeRuta`. Se suman al global, no lo sustituyen.
 *
 * Por qué hace falta el "sólo": `ThrottlerGuard` aplica TODOS los limitadores
 * declarados a toda ruta que protege, y aquí protege toda la API (`APP_GUARD`).
 * Sin más, el 5/min del POST del RSVP caería sobre cada endpoint. Cada
 * limitador con nombre lleva un `skipIf` que lo salta salvo en las rutas
 * marcadas: es opción pública de `@nestjs/throttler`, sin subclasear el guard
 * ni leer sus claves internas de metadatos. El olvido posible queda del lado
 * seguro: una ruta sin `@LimiteDeRuta` tiene sólo el global, nunca un límite
 * ajeno.
 */
export const LIMITADOR_GLOBAL = 'global'
export const LIMITADOR_RSVP = 'rsvp'
export const LIMITADOR_LOGIN = 'login'

type LimitadorDeRuta = typeof LIMITADOR_RSVP | typeof LIMITADOR_LOGIN

const reflector = new Reflector()
const marca = (nombre: LimitadorDeRuta): string => `limitador-de-ruta:${nombre}`

/** ¿Pide esta ruta (el método o su controlador) el limitador `nombre`? */
function pedidoEn(contexto: ExecutionContext, nombre: LimitadorDeRuta): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(marca(nombre), [
      contexto.getHandler(),
      contexto.getClass(),
    ]) === true
  )
}

/**
 * Aplica el limitador con nombre a esta ruta con estos valores. Es la ÚNICA
 * forma de activarlo: `@Throttle({ rsvp: ... })` a secas fijaría los valores
 * pero el `skipIf` lo seguiría saltando.
 */
export function LimiteDeRuta(
  nombre: LimitadorDeRuta,
  opciones: Parameters<typeof Throttle>[0][string],
): MethodDecorator & ClassDecorator {
  return applyDecorators(Throttle({ [nombre]: opciones }), SetMetadata(marca(nombre), true))
}

export function crearLimitadores(limiteGlobalPorMinuto: number): ThrottlerOptions[] {
  return [
    { name: LIMITADOR_GLOBAL, ttl: 60_000, limit: limiteGlobalPorMinuto },
    // Los valores de los limitadores con nombre son el defecto; el efectivo lo
    // fija cada `@LimiteDeRuta`.
    {
      name: LIMITADOR_RSVP,
      ttl: 60_000,
      limit: 20,
      skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_RSVP),
    },
    {
      name: LIMITADOR_LOGIN,
      ttl: 900_000,
      limit: 5,
      skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_LOGIN),
    },
  ]
}
