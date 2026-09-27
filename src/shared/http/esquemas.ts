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

/**
 * `YYYY-MM-DD` o ISO completo con offset → Date. Sólo string: `z.coerce.date()`
 * aceptaba también number y boolean (`weddingDate: 0` guardaba 1970-01-01), y
 * la frontera de una API no debe coercer tipos que el cliente no mandó como
 * fecha.
 */
export const fechaSchema = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((valor) => new Date(valor))

/**
 * Lo que el cliente DECLARA de una foto antes de subirla (avatar, portfolio).
 * Tipo y tamaño se vuelven a comprobar en R2 al confirmar: esto sólo decide
 * qué se firma.
 */
export const archivoDeImagenSchema = z
  .object({
    contentType: z.string().trim().min(1).max(100),
    size: z.number().int().positive(),
  })
  .strict()
