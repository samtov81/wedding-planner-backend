import { z } from 'zod'

/**
 * Los cuatro campos de `EntradaVendorRef` llegan opcionales: es
 * `parseVendorRef` quien decide si la combinación es válida (422 con motivo),
 * no Zod. Repetir esa regla aquí con `.refine` sería la MISMA validación en
 * dos sitios, exactamente lo que el value object existe para evitar.
 */
export const createEventVendorSchema = z.object({
  vendorProfileId: z.string().trim().min(1).optional(),
  externalName: z.string().trim().min(1).optional(),
  externalEmail: z.email().optional(),
  externalPhone: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).max(200),
  specialty: z.string().trim().min(1).max(200).optional(),
  assignedBudget: z.number().positive().optional(),
})
export type CreateEventVendorDto = z.infer<typeof createEventVendorSchema>

export const updateEventVendorSchema = z
  .object({
    category: z.string().trim().min(1).max(200).optional(),
    specialty: z.string().trim().min(1).max(200).nullable().optional(),
    assignedBudget: z.number().positive().nullable().optional(),
    status: z.enum(['SHORTLISTED', 'BOOKED', 'CANCELLED']).optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'Indica al menos un cambio',
  })
export type UpdateEventVendorDto = z.infer<typeof updateEventVendorSchema>
