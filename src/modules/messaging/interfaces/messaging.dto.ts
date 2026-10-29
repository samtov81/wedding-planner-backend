import { z } from 'zod'

/**
 * La forma laxa 8-4-4-4-12, como las demás rutas con id: uno que no la tiene
 * es un 404, no un P2023 de Prisma convertido en 500.
 */
export const idSchema = z.guid()

export const abrirConversacionSchema = z.object({ userId: z.guid() })

/**
 * Recortado y acotado. Zod cuenta unidades UTF-16 y el dominio puntos de
 * código, así que aquí un emoji pesa 2: este tope es el más estricto y el
 * definitivo es `normalizarCuerpo`, la segunda barrera.
 */
export const enviarMensajeSchema = z.object({ body: z.string().trim().min(1).max(2000) })

export const marcarSchema = z.object({ upTo: z.guid() })

export const listarMensajesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  /** Acotado arriba: sin tope, `?limit=1000000` es una denegación gratis. */
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
