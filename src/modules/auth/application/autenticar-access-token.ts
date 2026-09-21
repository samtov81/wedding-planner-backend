import type { UserRepository } from '@/modules/users/application/user.repository'
import type { SystemRole } from '@/modules/users/domain/user'
import { UnauthorizedError } from '@/shared/domain'

import type { TokenService } from './token.service'

/**
 * Lo que queda de un access token aceptado: el usuario RECARGADO de la base de
 * datos, no lo que venía firmado en el token. Lleva email y nombre porque
 * `GET /auth/me` con sólo `{ id, systemRole }` no le sirve de nada al frontend.
 */
export interface UsuarioAutenticado {
  id: string
  email: string
  fullName: string
  systemRole: SystemRole
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

/** Mensaje ÚNICO: token mal firmado, caducado, con rol inventado o de un usuario borrado. */
export const ACCESS_TOKEN_RECHAZADO = 'Token de acceso inválido o caducado'

/**
 * ÚNICA forma de convertir un access token en un usuario. La usan
 * `JwtAuthGuard` (REST) y el gateway de sockets (Tarea 15): un canal de tiempo
 * real con su propia autenticación acaba teniendo su propia política, y basta
 * con que uno de los dos se salte un paso para que un usuario borrado siga
 * escuchando lo que ya no puede leer.
 *
 * Se recarga el usuario en vez de confiar en los claims porque un usuario
 * borrado, o degradado de ADMIN a USER, conservaría acceso completo durante lo
 * que quedara del TTL. El `role` del token se valida igualmente contra
 * `SystemRole`: `verificarAccess` hace `String(payload.role)`, así que un token
 * acuñado sin ese claim produciría la cadena literal `'undefined'` tipada como
 * rol. La fuente de verdad del rol es la fila del usuario, no el token.
 *
 * Lanza `UnauthorizedError` con el mismo mensaje en todos los casos: distinguir
 * "firma mala" de "usuario borrado" le diría a quien prueba tokens qué ha
 * acertado.
 *
 * Devuelve también `expiraEn`, la caducidad del TOKEN (no de la sesión): el
 * REST la ignora — cada petición trae su token y se vuelve a verificar — y el
 * gateway de sockets la necesita para echar la conexión cuando llegue, porque
 * un socket no vuelve a presentar credenciales por sí solo.
 */
export async function autenticarAccessToken(
  tokens: Pick<TokenService, 'verificarAccess'>,
  usuarios: Pick<UserRepository, 'findById'>,
  token: string,
): Promise<{ usuario: UsuarioAutenticado; expiraEn: Date }> {
  let sub: string
  let exp: number
  try {
    const payload = tokens.verificarAccess(token)
    if (!esSystemRole(payload.role)) throw new UnauthorizedError(ACCESS_TOKEN_RECHAZADO)
    sub = payload.sub
    exp = payload.exp
  } catch {
    throw new UnauthorizedError(ACCESS_TOKEN_RECHAZADO)
  }

  const usuario = await usuarios.findById(sub)
  if (usuario === null) throw new UnauthorizedError(ACCESS_TOKEN_RECHAZADO)

  return {
    usuario: {
      id: usuario.id,
      email: usuario.email,
      fullName: usuario.fullName,
      systemRole: usuario.systemRole,
    },
    // `exp` va en SEGUNDOS epoch (RFC 7519), no en milisegundos.
    expiraEn: new Date(exp * 1000),
  }
}
