import { z } from 'zod'

import { RSVP_STATUSES } from '../domain/guest'

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
})
export type CrearInvitadoDto = z.infer<typeof crearInvitadoSchema>

export const actualizarInvitadoSchema = crearInvitadoSchema
  .partial()
  .extend({ rsvp: rsvpSchema.optional() })
  .refine((datos) => Object.keys(datos).length > 0, { message: 'Indica al menos un cambio' })
export type ActualizarInvitadoDto = z.infer<typeof actualizarInvitadoSchema>
