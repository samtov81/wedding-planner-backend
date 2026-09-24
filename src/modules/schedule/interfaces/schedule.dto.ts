import { z } from 'zod'

import { ubicacionSchema } from '@/shared/http/esquemas'

const instante = z.iso.datetime({ offset: true }).transform((v) => new Date(v))
const estado = z.enum(['PENDING', 'IN_PROGRESS', 'DONE'])

export const createScheduleItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    startsAt: instante,
    endsAt: instante.nullable().optional(),
    location: ubicacionSchema.nullable().optional(),
    status: estado.optional(),
  })
  .strict()
  .refine((d) => d.endsAt == null || d.endsAt.getTime() >= d.startsAt.getTime(), {
    message: 'La hora de fin no puede ser anterior a la de inicio',
    path: ['endsAt'],
  })

export const updateScheduleItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    startsAt: instante.optional(),
    endsAt: instante.nullable().optional(),
    location: ubicacionSchema.nullable().optional(),
    status: estado.optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Indica al menos un cambio' })
