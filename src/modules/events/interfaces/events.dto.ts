import { z } from 'zod'

export const createEventSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /**
   * Se acepta la fecha como ISO y se convierte aquí, en la frontera: dentro
   * del dominio `weddingDate` es un `Date` y nunca una cadena que alguien
   * tenga que acordarse de parsear.
   */
  weddingDate: z.coerce.date(),
})
export type CreateEventDto = z.infer<typeof createEventSchema>

export const inviteMemberSchema = z.object({
  email: z.email(),
  /** Sólo los dos roles de planificación: `VENDOR` no es una membresía. */
  role: z.enum(['COUPLE', 'PLANNER']),
})
export type InviteMemberDto = z.infer<typeof inviteMemberSchema>
