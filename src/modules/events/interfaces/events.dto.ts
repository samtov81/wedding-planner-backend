import { z } from 'zod'

export const createEventSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /**
   * Se acepta la fecha como ISO y se convierte aquí, en la frontera: dentro
   * del dominio `weddingDate` es un `Date` y nunca una cadena que alguien
   * tenga que acordarse de parsear.
   */
  weddingDate: z.coerce.date(),
  /**
   * Días antes de la boda en que se cierra el RSVP. Opcional: sin él, la
   * columna aplica su default (14). El rango es el mismo que el CHECK de la
   * migración, para que un valor fuera de rango sea un 400 y no un 500.
   */
  rsvpDeadlineDays: z.number().int().min(0).max(365).optional(),
})
export type CreateEventDto = z.infer<typeof createEventSchema>

export const inviteMemberSchema = z.object({
  email: z.email(),
  /** Sólo los dos roles de planificación: `VENDOR` no es una membresía. */
  role: z.enum(['COUPLE', 'PLANNER']),
})
export type InviteMemberDto = z.infer<typeof inviteMemberSchema>
