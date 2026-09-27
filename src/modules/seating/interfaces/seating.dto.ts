import { z } from 'zod'

import {
  MAX_ASIENTOS_POR_MESA,
  MAX_INDICE_ACOMPANANTE,
  MAX_MESAS_POR_EVENTO,
} from '../domain/seating'

const asientos = z.number().int().min(1).max(MAX_ASIENTOS_POR_MESA)
const nombre = z.string().trim().min(1).max(60)
const coordenada = z.number().int().min(0).max(10_000)
const minNoSuperaMax = {
  check: (d: { minSeats?: number | undefined; maxSeats?: number | undefined }) =>
    d.minSeats === undefined || d.maxSeats === undefined || d.minSeats <= d.maxSeats,
  mensaje: { message: 'El mínimo no puede superar al máximo', path: ['maxSeats'] },
}

export const generarMesasSchema = z
  .object({
    count: z.number().int().min(1).max(MAX_MESAS_POR_EVENTO),
    minSeats: asientos,
    maxSeats: asientos,
  })
  .strict()
  .refine(minNoSuperaMax.check, minNoSuperaMax.mensaje)

export const crearMesaSchema = z
  .object({ name: nombre.optional(), minSeats: asientos, maxSeats: asientos })
  .strict()
  .refine(minNoSuperaMax.check, minNoSuperaMax.mensaje)

export const actualizarMesaSchema = z
  .object({
    name: nombre.optional(),
    minSeats: asientos.optional(),
    maxSeats: asientos.optional(),
    seatCount: asientos.optional(),
    x: coordenada.optional(),
    y: coordenada.optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Indica al menos un cambio' })
  .refine(minNoSuperaMax.check, minNoSuperaMax.mensaje)

const indiceDeAsiento = z
  .number()
  .int()
  .min(0)
  .max(MAX_ASIENTOS_POR_MESA - 1)

export const asignarAsientoSchema = z
  .object({
    tableId: z.uuid(),
    seatIndex: indiceDeAsiento,
    guestId: z.uuid(),
    companionIndex: z.number().int().min(0).max(MAX_INDICE_ACOMPANANTE),
  })
  .strict()

/** El índice llega como texto en la ruta. */
export const indiceDeAsientoDeRuta = z.coerce.number().pipe(indiceDeAsiento)
