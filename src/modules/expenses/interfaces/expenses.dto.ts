import { z } from 'zod'

import { montoSchema } from '@/shared/http/esquemas'

/** Monto de un gasto: estrictamente positivo (el CHECK de la tabla también lo exige). */
const montoPositivo = montoSchema.refine((m) => m !== '0.00', {
  message: 'El monto debe ser mayor que 0',
})
const fechaDia = z.iso.date().transform((d) => new Date(`${d}T00:00:00.000Z`))
const estado = z.enum(['PENDING', 'PAID'])

const origenCampos = {
  eventVendorId: z.uuid().optional(),
  payeeName: z.string().trim().min(1).max(200).optional(),
}

type OrigenCrudo = { eventVendorId?: string | undefined; payeeName?: string | undefined }

function origenDe(d: OrigenCrudo) {
  if (d.eventVendorId !== undefined)
    return { kind: 'vendor' as const, eventVendorId: d.eventVendorId }
  if (d.payeeName !== undefined) return { kind: 'external' as const, payeeName: d.payeeName }
  return undefined
}

const unSoloOrigen = (d: OrigenCrudo) =>
  !(d.eventVendorId !== undefined && d.payeeName !== undefined)

export const createExpenseSchema = z
  .object({
    concept: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(100),
    amount: montoPositivo,
    dueDate: fechaDia.nullable().optional(),
    status: estado.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    ...origenCampos,
  })
  .strict()
  .refine((d) => unSoloOrigen(d) && origenDe(d) !== undefined, {
    message: 'Indica exactamente uno: eventVendorId o payeeName',
  })
  .transform(({ eventVendorId, payeeName, ...resto }) => {
    const origen = origenDe({ eventVendorId, payeeName })
    // El refine garantiza que existe; el `if` es para el tipo.
    if (origen === undefined) throw new Error('origen ausente tras validar')
    return { ...resto, origen }
  })

export const updateExpenseSchema = z
  .object({
    concept: z.string().trim().min(1).max(200).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    amount: montoPositivo.optional(),
    dueDate: fechaDia.nullable().optional(),
    status: estado.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    ...origenCampos,
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Indica al menos un cambio' })
  .refine(unSoloOrigen, { message: 'Indica solo uno: eventVendorId o payeeName' })
  .transform(({ eventVendorId, payeeName, ...resto }) => {
    const origen = origenDe({ eventVendorId, payeeName })
    return origen === undefined ? resto : { ...resto, origen }
  })

export const listExpensesQuerySchema = z.object({
  status: estado.optional(),
  origin: z.enum(['vendor', 'external']).optional(),
  eventVendorId: z.uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})
