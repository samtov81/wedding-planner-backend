import { z } from 'zod'

import { ubicacionSchema } from '@/shared/http/esquemas'

const instante = z.iso.datetime({ offset: true }).transform((v) => new Date(v))
const estado = z.enum(['PENDING', 'IN_PROGRESS', 'DONE'])

/**
 * El conjunto COMPLETO de contrataciones asignadas a un ítem (spec 2026-11-10
 * §3). Tope 50 y sin repetidos, como `compartirSchema` del moodboard: un
 * repetido es un cliente roto, y aceptarlo en silencio ocultaría el fallo.
 * `z.guid()` y no `z.uuid()`: lo que se exige es la FORMA (que no llegue a
 * Postgres un texto que no es uuid, 22P02 → 500), no la versión del uuid.
 */
const eventVendorIds = z
  .array(z.guid())
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'eventVendorIds must not contain duplicates',
  })

export const createScheduleItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    startsAt: instante,
    endsAt: instante.nullable().optional(),
    location: ubicacionSchema.nullable().optional(),
    status: estado.optional(),
    /** Sólo del planner; con él presente, quien no lo es recibe 403 (ver el caso de uso). */
    eventVendorIds: eventVendorIds.optional(),
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

export const asignarProveedoresSchema = z.object({ eventVendorIds }).strict()

/**
 * Sólo que sea texto: el 1..2000 tras `trim` es regla de dominio (422
 * `INVALID_NOTE`, `normalizarNota`), y validarlo aquí daría un 400 que además
 * llegaría ANTES que el 404 de quien no es planner, revelando la ruta.
 */
export const notaSchema = z.object({ body: z.string() }).strict()

/**
 * Lo que el proveedor tenía delante al pulsar "Confirm" (spec 2026-11-10 §4):
 * cada ítem con la hora que vio. `endsAt` es obligatorio (null = sin fin) para
 * que "no lo mandé" no se confunda con "no tenía fin". `itemId` con `z.guid()`:
 * un id que no es uuid es 400 aquí y nunca llega a Postgres (22P02 → 500).
 * Tope de 500: un evento no tiene tantos ítems, y sin tope un cuerpo enorme
 * bloquearía cientos de filas en una sola transacción.
 */
export const confirmarSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            itemId: z.guid(),
            startsAt: instante,
            endsAt: instante.nullable(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
