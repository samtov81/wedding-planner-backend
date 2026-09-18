import { createHash, randomBytes } from 'node:crypto'

/**
 * Estados de una invitación. Se declara aquí y NO se importa el enum de
 * `@prisma/client`, por el mismo motivo que `RsvpStatus`: el dominio no conoce
 * el ORM. El compilador sigue atando ambos en el adaptador.
 */
export type InvitationStatus =
  'QUEUED' | 'SENT' | 'DELIVERED' | 'BOUNCED' | 'COMPLAINED' | 'RESPONDED'

export const DIAS_DE_VALIDEZ = 90

/**
 * Token de RSVP. Mismo criterio que el refresh token: se entrega el token en
 * claro (viaja en el enlace del correo) y se persiste sólo su hash. Si se
 * filtra la base de datos, no se obtienen enlaces válidos con los que responder
 * por otros.
 */
export function generarTokenInvitacion(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashDeToken(token) }
}

/** SHA-256 en hexadecimal. Lo usa el RSVP público (Tarea 14) para buscar por hash. */
export function hashDeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function caducidadInvitacion(desde = new Date()): Date {
  return new Date(desde.getTime() + DIAS_DE_VALIDEZ * 86_400_000)
}
