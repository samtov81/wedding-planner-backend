import { z } from 'zod'

import { MONEDAS } from '@/modules/events/domain/moneda'
import { montoSchema, ubicacionSchema } from '@/shared/http/esquemas'

import type { EntradaFicha } from '../application/my-vendor-profile.use-cases'
import { MAX_PAQUETES, MAX_PUBLICACIONES } from '../domain/vendor-profile'
import { slugDeCategoriaSchema } from './categoria.dto'

/** Texto opcional: vacío o ausente se guarda como `null`. */
function opcional(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined || v === null || v === '' ? null : v))
}

/**
 * PUT completo: lo que no llega se guarda vacío. Es el formulario entero de
 * la ficha, no un parche; así "borrar un campo" es simplemente mandarlo vacío.
 */
export const fichaSchema = z
  .object({
    businessName: z.string().trim().min(1).max(200),
    /** `slug` del catálogo de categorías (`GET /vendor-categories`). */
    category: slugDeCategoriaSchema,
    specialty: opcional(200),
    tagline: opcional(200),
    bio: opcional(5000),
    quote: opcional(500),
    yearsExperience: z.number().int().min(0).max(100).nullable().optional().default(null),
    responseTime: opcional(40),
    currency: z.enum(MONEDAS).optional().default('USD'),
    publications: z
      .array(z.string().trim().min(1).max(100))
      .max(MAX_PUBLICACIONES)
      .optional()
      .default([]),
    contact: z
      .object({
        email: z
          .union([z.email().max(254), z.literal('')])
          .nullable()
          .optional()
          .transform((v) => (v === undefined || v === null || v === '' ? null : v)),
        phone: opcional(50),
        website: opcional(300),
      })
      .strict()
      .optional()
      .default({ email: null, phone: null, website: null }),
    location: ubicacionSchema.nullable().optional().default(null),
  })
  .strict()
  .transform((f): EntradaFicha => ({
    ...f,
    yearsExperience: f.yearsExperience ?? null,
    contact: {
      email: f.contact.email ?? null,
      phone: f.contact.phone ?? null,
      website: f.contact.website ?? null,
    },
  }))

export const modoProveedorSchema = z.object({ active: z.boolean() }).strict()

export const paquetesSchema = z
  .object({
    packages: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            description: z.string().trim().min(1).max(2000),
            price: montoSchema.refine((p) => p !== '0.00', {
              message: 'El precio debe ser mayor que 0',
            }),
          })
          .strict(),
      )
      .max(MAX_PAQUETES),
  })
  .strict()

export const nuevaFotoSchema = z
  .object({
    key: z.string().trim().min(1).max(300),
    alt: z.string().trim().max(300).optional().default(''),
  })
  .strict()

export const editarFotoSchema = z.object({ alt: z.string().trim().max(300) }).strict()

export const ordenDeFotosSchema = z.object({ ids: z.array(z.uuid()).max(100) }).strict()
