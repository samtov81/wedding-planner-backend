import { z } from 'zod'

/**
 * La respuesta del invitado. Sólo CONFIRMED o DECLINED: "PENDING" no es una
 * respuesta, es la ausencia de ella.
 *
 * `dietary` distingue ausente (no se toca) de `null` (se borra), igual que en
 * `actualizarInvitadoSchema`; mismos límites que allí.
 */
export const responderRsvpSchema = z.object({
  rsvp: z.enum(['CONFIRMED', 'DECLINED']),
  dietary: z.string().trim().min(1).max(200).nullable().optional(),
})
export type ResponderRsvpDto = z.infer<typeof responderRsvpSchema>

/**
 * Forma del token: 32 bytes en base64url sin relleno (`generarTokenInvitacion`)
 * son 43 caracteres. Un token con otra forma no puede existir, así que se
 * rechaza sin tocar la base de datos — pero con el MISMO error que uno
 * inexistente (ver el controlador), no con un 400 que lo distinga.
 */
export const tokenRsvpSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
