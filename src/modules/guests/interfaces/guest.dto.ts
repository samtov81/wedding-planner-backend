import { z } from 'zod'

import type { FilaImportacion } from '../application/import-guests.use-case'
import { MAX_ACOMPANANTES, RSVP_STATUSES } from '../domain/guest'

/**
 * DESIGN-GAP: el brief de la Tarea 11 escribe estos DTOs con `nestjs-zod`
 * (`createZodDto`) y pide instalar `nestjs-zod` y `@nestjs/swagger`. Aquí se
 * usan esquemas de Zod pelados validados con `validarCon`, que es el helper de
 * frontera que YA usan todos los controladores del repo. Motivos: la forma del
 * 400 es un contrato único con el frontend y vive en `validarCon`
 * —`createZodDto` lo devolvería al pipe global, con otro cuerpo—, y ninguna de
 * las dos dependencias nuevas aporta nada más aquí (no hay OpenAPI en este
 * backend todavía). Cuando se añada Swagger, se revisará.
 */
const rsvpSchema = z.enum(RSVP_STATUSES)

/** El límite se acota arriba: sin tope, `?limit=1000000` es una denegación gratis. */
export const listarInvitadosQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  rsvp: rsvpSchema.optional(),
  group: z.string().min(1).max(50).optional(),
  q: z.string().min(1).max(100).optional(),
})
export type ListarInvitadosQuery = z.infer<typeof listarInvitadosQuerySchema>

export const crearInvitadoSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /**
   * OPCIONAL: se invita también por teléfono, en persona o por carta. Lo que
   * esto arrastra no está aquí sino en el envío (Tarea 12): un invitado sin
   * email no puede recibir invitación, y eso se dice, no se silencia.
   */
  email: z.email().optional(),
  group: z.string().trim().min(1).max(50),
  dietary: z.string().trim().min(1).max(200).nullable().optional(),
  /** Cupo de acompañantes. Ausente = 0: la mayoría de invitados viene sola. */
  companionsAllowed: z.number().int().min(0).max(MAX_ACOMPANANTES).default(0),
})
export type CrearInvitadoDto = z.infer<typeof crearInvitadoSchema>

/**
 * Tope de filas por importación. Una boda grande ronda los 300-400 invitados;
 * sin tope, un cuerpo enorme es una denegación gratis y un INSERT gigante.
 */
export const MAX_FILAS_IMPORTACION = 500

/**
 * Sólo la FORMA del lote: cada fila se valida después, una a una, en el caso
 * de uso, para poder decir QUÉ fila falla. Con `z.array(crearInvitadoSchema)`
 * el 400 diría "guests.37.email" mezclado con los demás y sin los duplicados.
 */
export const importarInvitadosSchema = z.object({
  guests: z.array(z.unknown()).min(1).max(MAX_FILAS_IMPORTACION),
})

/** Valida una fila de la importación sin lanzar: sus fallos van al informe por fila. */
export function validarFilaImportacion(fila: unknown): FilaImportacion {
  const resultado = crearInvitadoSchema.safeParse(fila)
  if (!resultado.success) {
    return {
      ok: false,
      fallos: resultado.error.issues.map((issue) => ({
        field: issue.path.map(String).join('.') || 'row',
        message: issue.message,
      })),
    }
  }
  const d = resultado.data
  return {
    ok: true,
    datos: {
      name: d.name,
      email: d.email ?? null,
      group: d.group,
      dietary: d.dietary ?? null,
      companionsAllowed: d.companionsAllowed,
    },
  }
}

export const actualizarInvitadoSchema = crearInvitadoSchema
  .partial()
  .extend({
    // Sin `.default(0)`: en un PATCH, ausente significa "no lo toques".
    companionsAllowed: z.number().int().min(0).max(MAX_ACOMPANANTES).optional(),
    rsvp: rsvpSchema.optional(),
    // A diferencia de `crearInvitadoSchema.email` (sólo ausente u ok), el PATCH
    // también acepta `null` explícito: es cómo se borra un correo ya puesto.
    // Ausente (`undefined`) sigue significando "no toques este campo".
    email: z.email().nullable().optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, { message: 'Indica al menos un cambio' })
export type ActualizarInvitadoDto = z.infer<typeof actualizarInvitadoSchema>
