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
export const enviarMensajeSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1)
    .refine((s) => [...s].length <= 2000, { message: 'Too big: expected at most 2000 characters' }),
})

export const marcarSchema = z.object({ upTo: z.guid() })

export const listarMensajesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  /** Acotado arriba: sin tope, `?limit=1000000` es una denegación gratis. */
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
