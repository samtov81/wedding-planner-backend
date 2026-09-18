import type { ThrottlerOptions } from '@nestjs/throttler'

/**
 * Los limitadores de ritmo con nombre. `ThrottlerModule` los declara todos
 * (`app.module.ts`) y cada ruta que se protege elige el suyo con
 * `@UseGuards(ThrottlerGuard)` + `@Throttle({ [nombre]: ... })`.
 *
 * OJO al añadir uno: `ThrottlerGuard` aplica TODOS los limitadores declarados a
 * toda ruta que lleve el guard, no sólo el que nombra su `@Throttle`. Por eso
 * cada ruta protegida se salta explícitamente los ajenos con `@SkipThrottle`.
 *
 * Los valores de aquí son el defecto; el límite efectivo lo fija cada ruta.
 */
export const LIMITADOR_RSVP = 'rsvp'
export const LIMITADOR_LOGIN = 'login'

export const LIMITADORES: ThrottlerOptions[] = [
  { name: LIMITADOR_RSVP, ttl: 60_000, limit: 20 },
  { name: LIMITADOR_LOGIN, ttl: 900_000, limit: 5 },
]
