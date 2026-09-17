import { type CustomDecorator, SetMetadata } from '@nestjs/common'

import type { PermisoDeEvento } from '../domain/event-access'

export const PERMITIDOS = 'permitidos'

/**
 * Restringe una ruta a ciertas formas de estar en el evento. Sin el decorador,
 * la ruta la puede usar CUALQUIERA con acceso al evento — que es lo correcto
 * para lecturas: el filtro fino es el 404 del guard, no esta lista.
 *
 * `ADMIN` no se nombra nunca aquí: el guard lo resuelve antes de mirar la
 * lista, para que añadir un permiso no exija acordarse de incluirlo.
 */
export const RequireEventAccess = (...roles: PermisoDeEvento[]): CustomDecorator<string> =>
  SetMetadata(PERMITIDOS, roles)
