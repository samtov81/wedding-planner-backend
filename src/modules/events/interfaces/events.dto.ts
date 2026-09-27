import { z } from 'zod'

import { fechaSchema, montoSchema, ubicacionSchema } from '@/shared/http/esquemas'

import { MONEDAS } from '../domain/moneda'

/** 'UTC' no siempre está en `supportedValuesOf`, pero es el default de la columna. */
const ZONAS = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])

const timezoneSchema = z
  .string()
  .trim()
  .refine((tz) => ZONAS.has(tz), { message: 'Zona horaria desconocida' })

const camposEditables = {
  weddingDate: fechaSchema.nullable().optional(),
  timezone: timezoneSchema.optional(),
  currency: z.enum(MONEDAS).optional(),
  totalBudget: montoSchema.nullable().optional(),
  venue: ubicacionSchema.nullable().optional(),
}

export const createEventSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    rsvpDeadlineDays: z.number().int().min(0).max(365).optional(),
    ...camposEditables,
  })
  .strict()
export type CreateEventDto = z.infer<typeof createEventSchema>

/**
 * `status` NO se acepta aquí: publicar tiene su propia ruta, con su propia
 * validación. Así un PATCH nunca publica ni despublica por accidente.
 */
export const updateEventSchema = z
  .object({ name: z.string().trim().min(1).max(200).optional(), ...camposEditables })
  .strict()
  .refine((datos) => Object.keys(datos).length > 0, { message: 'Indica al menos un cambio' })
export type UpdateEventDto = z.infer<typeof updateEventSchema>

export const inviteMemberSchema = z.object({
  email: z.email(),
  /** Sólo los dos roles de planificación: `VENDOR` no es una membresía. */
  role: z.enum(['COUPLE', 'PLANNER']),
})
export type InviteMemberDto = z.infer<typeof inviteMemberSchema>
