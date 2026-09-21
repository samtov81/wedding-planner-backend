import { type CustomDecorator, SetMetadata } from '@nestjs/common'

import type { PermisoDeEvento } from '../domain/event-access'

export const PERMITIDOS = 'permitidos'

/**
 * Restringe una ruta a ciertas formas de estar en el evento. OBLIGATORIO en
 * toda ruta bajo `EventAccessGuard`: sin él, el guard lanza (500) en vez de
 * dejar pasar a cualquiera. Una ruta abierta a todo acceso lo dice en voz alta:
 * `@RequireEventAccess('COUPLE', 'PLANNER', 'VENDOR')`.
 *
 * Vale en el método o en la clase; si están los dos, gana el del método.
 *
 * `ADMIN` no se nombra nunca aquí: el guard lo resuelve antes de mirar la
 * lista, para que añadir un permiso no exija acordarse de incluirlo.
 */
export const RequireEventAccess = (...roles: PermisoDeEvento[]): CustomDecorator<string> =>
  SetMetadata(PERMITIDOS, roles)
