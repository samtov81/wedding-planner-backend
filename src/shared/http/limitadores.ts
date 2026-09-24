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
 *  - `webhook`: también con nombre, pero el global se SALTA en vez de
 *    sumarse — ver más abajo por qué.
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
export const LIMITADOR_REGISTER = 'register'
export const LIMITADOR_VERIFY_EMAIL = 'verify-email'
export const LIMITADOR_WEBHOOK = 'webhook'
export const LIMITADOR_RESEND_VERIFICATION = 'resend-verification'
export const LIMITADOR_FORGOT_PASSWORD = 'forgot-password'
export const LIMITADOR_RESET_PASSWORD = 'reset-password'

type LimitadorDeRuta =
  | typeof LIMITADOR_RSVP
  | typeof LIMITADOR_LOGIN
  | typeof LIMITADOR_REGISTER
  | typeof LIMITADOR_VERIFY_EMAIL
  | typeof LIMITADOR_WEBHOOK
  | typeof LIMITADOR_RESEND_VERIFICATION
  | typeof LIMITADOR_FORGOT_PASSWORD
  | typeof LIMITADOR_RESET_PASSWORD

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
    {
      name: LIMITADOR_GLOBAL,
      ttl: 60_000,
      limit: limiteGlobalPorMinuto,
      // El webhook de Resend llega en ráfagas desde pocas IPs de Svix; su barrera
      // es la firma. Lleva su propio límite, más alto.
      skipIf: (contexto) => pedidoEn(contexto, LIMITADOR_WEBHOOK),
    },
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
    {
      name: LIMITADOR_REGISTER,
      ttl: 900_000,
      limit: 5,
      skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_REGISTER),
    },
    {
      name: LIMITADOR_VERIFY_EMAIL,
      ttl: 900_000,
      limit: 10,
      skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_VERIFY_EMAIL),
    },
    {
      name: LIMITADOR_WEBHOOK,
      ttl: 60_000,
      limit: 1200,
      skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_WEBHOOK),
    },
    {
      name: LIMITADOR_RESEND_VERIFICATION,
      ttl: 3_600_000,
      limit: 3,
      skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_RESEND_VERIFICATION),
    },
    {
      name: LIMITADOR_FORGOT_PASSWORD,
      ttl: 3_600_000,
      limit: 3,
      skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_FORGOT_PASSWORD),
    },
    {
      name: LIMITADOR_RESET_PASSWORD,
      ttl: 900_000,
      limit: 10,
      skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_RESET_PASSWORD),
    },
  ]
}
