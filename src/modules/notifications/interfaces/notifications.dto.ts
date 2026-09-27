import { z } from 'zod'

/**
 * `unread` llega como texto en la query: sólo `true`/`false` literales. Un
 * `z.coerce.boolean()` convertiría `"false"` en `true`.
 */
export const listarNotificacionesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  /** Acotado arriba: sin tope, `?limit=1000000` es una denegación gratis. */
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unread: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

/**
 * La forma laxa 8-4-4-4-12, como `EventAccessGuard` con `:eventId`: un id que
 * no la tiene es un 404, no un P2023 de Prisma convertido en 500.
 */
export const notificationIdSchema = z.guid()
