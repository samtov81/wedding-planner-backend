import { z } from 'zod'

import { MAX_DIMENSION } from '../domain/moodboard'

/**
 * Esquemas de entrada del moodboard. La FORMA (tipos, enteros, rangos, uuids)
 * es 400 aquí; las reglas de dominio que dependen de normalizar (título y nota
 * 1..N tras `trim`) son del dominio (422 `INVALID_TITLE` / `INVALID_NOTE`), así
 * que aquí sólo se exige que sean texto. Tipo y tamaño de la imagen los decide
 * `SubidaDeImagenes` (422 `INVALID_IMAGE`): repetirlos aquí daría dos códigos
 * para la misma regla.
 */

export const uploadUrlSchema = z
  .object({
    contentType: z.string(),
    bytes: z.number().int().positive(),
  })
  .strict()

/**
 * `width`/`height` 1..20000 se validan aquí (400) además del CHECK
 * `moodboard_images_dimensiones`: sin esto, un valor fuera de rango llegaría
 * al INSERT y el CHECK saldría como 500.
 */
const dimension = z.number().int().min(1).max(MAX_DIMENSION)

export const crearImagenSchema = z
  .object({
    key: z.string().min(1),
    title: z.string(),
    categoryId: z.guid(),
    width: dimension,
    height: dimension,
  })
  .strict()

export const archivarSchema = z.object({ archived: z.boolean() }).strict()

/**
 * El conjunto COMPLETO de contrataciones con las que se comparte. Tope 50 y
 * sin repetidos: un repetido es un cliente roto, y aceptarlo en silencio
 * (el caso de uso deduplica) ocultaría el fallo.
 */
export const compartirSchema = z
  .object({
    eventVendorIds: z
      .array(z.guid())
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'eventVendorIds must not contain duplicates',
      }),
  })
  .strict()

export const notaSchema = z.object({ body: z.string() }).strict()

/** `?archived=true|false`; ausente = activas. */
export const listarImagenesQuerySchema = z.object({
  archived: z.enum(['true', 'false']).optional(),
})
