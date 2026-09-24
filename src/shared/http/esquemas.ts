import { z } from 'zod'

import { crearUbicacion, MontoInvalidoError, normalizarMonto } from '@/shared/domain'

/**
 * Monto de entrada: number o string. Sale como string normalizado ("1500.00").
 * El error de formato es un 400 de Zod, no el 422 del value object: aquí el
 * problema es la forma de la petición.
 */
export const montoSchema = z.union([z.number(), z.string()]).transform((valor, ctx) => {
  try {
    return normalizarMonto(valor)
  } catch (error) {
    if (!(error instanceof MontoInvalidoError)) throw error
    ctx.addIssue({ code: 'custom', message: error.message })
    return z.NEVER
  }
})

export const ubicacionSchema = z
  .object({
    name: z.string().trim().max(200).nullable().optional(),
    address: z.string().trim().min(1).max(500),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    mapboxId: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .transform((entrada) => crearUbicacion(entrada))

/** `YYYY-MM-DD` o ISO completo → Date. */
export const fechaSchema = z.coerce.date()
