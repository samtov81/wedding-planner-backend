import { z } from 'zod'

import { montoSchema } from '@/shared/http/esquemas'

/** Monto de un gasto: estrictamente positivo (el CHECK de la tabla también lo exige). */
const montoPositivo = montoSchema.refine((m) => m !== '0.00', {
  message: 'El monto debe ser mayor que 0',
})
const fechaDia = z.iso.date().transform((d) => new Date(`${d}T00:00:00.000Z`))
const estado = z.enum(['PENDING', 'PAID'])

/**
 * Datos de factura (spec 2026-11-11 §8). `null` quita el valor en el PATCH. El
 * número se recorta y debe quedar entre 1 y 60 caracteres: los casos de uso
 * confían en ello. El archivo es `{ key, name }`: tipo y tamaño los dice R2, no
 * el cliente, y por eso `.strict()` rechaza cualquier otro campo.
 */
const facturaCampos = {
  invoiceNumber: z.string().trim().min(1).max(60).nullable().optional(),
  subtotal: montoPositivo.nullable().optional(),
  invoiceFile: z
    .object({ key: z.string().min(1).max(300), name: z.string().trim().min(1).max(200) })
    .strict()
    .nullable()
    .optional(),
}

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
    ...facturaCampos,
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
    ...facturaCampos,
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
  status: z.enum(['PENDING', 'PAID', 'OVERDUE']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  origin: z.enum(['vendor', 'external']).optional(),
  eventVendorId: z.uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

/** Igual que el de moodboard: tipo y tamaño se validan en `SubidaDeFacturas`. */
export const uploadUrlSchema = z
  .object({
    contentType: z.string(),
    bytes: z.number().int().positive(),
  })
  .strict()

/** Mensaje del que se toma el adjunto para la factura. */
export const facturaDesdeMensajeSchema = z.object({ messageId: z.guid() }).strict()

export const vendorPaymentsQuerySchema = z.object({
  eventId: z.uuid().optional(),
})
