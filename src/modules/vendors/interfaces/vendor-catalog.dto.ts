import { z } from 'zod'

import { slugDeCategoriaSchema } from './categoria.dto'

const textoOpcional = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : v))

export const vendorCatalogQuerySchema = z.object({
  q: textoOpcional,
  /** `slug` de la categoría; uno que no existe simplemente no encuentra nada. */
  category: slugDeCategoriaSchema.optional().transform((v) => v ?? null),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
