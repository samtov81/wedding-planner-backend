import { z } from 'zod'

/**
 * La forma laxa 8-4-4-4-12, como las demás rutas con id: uno que no la tiene
 * es un 404, no un P2023 de Prisma convertido en 500.
 */
export const idSchema = z.guid()

export const abrirConversacionSchema = z.object({ userId: z.guid() })

/**
 * Recortado y acotado EN PUNTOS DE CÓDIGO, como `normalizarCuerpo`. Se hace
 * explícito con `refine` aunque el `max` de Zod 4 (4.6.5, comprobado) ya cuente
 * puntos de código: una versión de Zod que contara unidades UTF-16 pesaría un
 * emoji como 2 y rechazaría aquí lo que el dominio acepta. El e2e de 2000/2001
 * emoji fija el comportamiento. `[...s]` itera por puntos de código.
 */
export const enviarMensajeSchema = z
  .object({
    body: z
      .string()
      .trim()
      .refine((s) => [...s].length <= 2000, {
        message: 'Too big: expected at most 2000 characters',
      })
      .default(''),
    /**
     * Lo que devolvió `attachment-upload-url` (la key) más el nombre original.
     * Sólo comprueba la forma: que la key sea de esta conversación y que el
     * objeto exista lo decide el caso de uso.
     */
    attachment: z
      .object({ key: z.string().min(1).max(500), name: z.string().min(1).max(200) })
      .optional(),
  })
  .refine((m) => m.body.length > 0 || m.attachment !== undefined, {
    message: 'Too small: expected a body or an attachment',
    path: ['body'],
  })

/** El tipo y el tamaño admitidos los valida `SubidaDeAdjuntos` (INVALID_ATTACHMENT). */
export const subidaDeAdjuntoSchema = z.object({
  contentType: z.string().min(1),
  bytes: z.number().int().positive(),
})

export const marcarSchema = z.object({ upTo: z.guid() })

export const listarMensajesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  /** Acotado arriba: sin tope, `?limit=1000000` es una denegación gratis. */
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
