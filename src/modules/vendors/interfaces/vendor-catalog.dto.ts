import { z } from 'zod'

const textoOpcional = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : v))

export const vendorCatalogQuerySchema = z.object({
  q: textoOpcional,
  category: textoOpcional,
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
