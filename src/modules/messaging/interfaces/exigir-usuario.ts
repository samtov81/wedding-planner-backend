import type { UsuarioAutenticado } from '@/modules/auth/interfaces/current-user.decorator'
import { UnauthorizedError } from '@/shared/domain'

/**
 * El usuario que `JwtAuthGuard` dejó en la petición, o 401 si falta. Las rutas
 * de mensajería van todas tras ese guard, así que faltar es un cableado roto;
 * aun así se falla cerrado en vez de seguir con un `undefined`. Compartido por
 * los dos controladores del módulo. Alternativa descartada: llevarlo a
 * `shared/`, que obligaría a `shared/` a conocer el tipo de `auth` (otros
 * módulos tienen su propia copia por la misma razón).
 */
export function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}
