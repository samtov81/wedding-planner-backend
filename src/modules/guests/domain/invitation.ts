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

/**
 * Rango de cada estado. Los webhooks llegan desordenados y se reentregan, así
 * que el estado sólo AVANZA: un `delivered` que llega tarde no puede pisar un
 * `BOUNCED`, y nada del proveedor pisa un `RESPONDED` (el invitado ya contestó).
 *
 * `BOUNCED` y `COMPLAINED` comparten rango: son dos finales distintos del mismo
 * correo y ninguno "supera" al otro, así que el primero que llega se queda.
 * Mismo rango tampoco avanza: por eso reentregar un evento es un no-op.
 */
const ORDEN = {
  QUEUED: 0,
  SENT: 1,
  DELIVERED: 2,
  BOUNCED: 3,
  COMPLAINED: 3,
  RESPONDED: 4,
} as const satisfies Record<InvitationStatus, number>

/**
 * `satisfies Record<...>` obliga a dar rango a TODO estado (uno nuevo en el
 * tipo no compila hasta que se ordene). El `Map` es sólo para leerlo sin
 * indexar un objeto con una clave variable.
 */
const RANGO = new Map(Object.entries(ORDEN) as Array<[InvitationStatus, number]>)

/**
 * Los estados DESDE los que se puede pasar a `destino`: los de rango
 * estrictamente menor. Se devuelve la lista y no un booleano para que el
 * adaptador de Prisma la meta en el `WHERE` del UPDATE: la regla se cumple en
 * la MISMA sentencia que escribe, sin una lectura previa que una carrera pueda
 * dejar obsoleta.
 */
export function estadosQuePuedenAvanzarA(destino: InvitationStatus): InvitationStatus[] {
  // `?? 0` nunca actúa (el mapa es exhaustivo); si actuara, falla cerrado: nada avanza.
  const tope = RANGO.get(destino) ?? 0
  return [...RANGO].filter(([, rango]) => rango < tope).map(([estado]) => estado)
}

/** Momento a partir del cual el invitado ya no puede cambiar su respuesta. */
export function cierreRsvp(evento: { weddingDate: Date; rsvpDeadlineDays: number }): Date {
  return new Date(evento.weddingDate.getTime() - evento.rsvpDeadlineDays * 86_400_000)
}

/**
 * ¿Sirve el token para VER la invitación? Sólo mira la caducidad: se puede leer
 * en cualquier estado, también ya respondida y también pasado el cierre, para
 * que el invitado vea lo que contestó. `expiresAt` incluye la caducidad forzada
 * del ruling C18.
 */
export function admiteLectura(invitacion: { expiresAt: Date }, ahora: Date): boolean {
  return invitacion.expiresAt.getTime() > ahora.getTime()
}

/**
 * ¿Sirve el token para RESPONDER (o cambiar la respuesta)? Token vivo y antes
 * del cierre. Ya no es de un solo uso (decisión del usuario, bloque A §2): una
 * invitación RESPONDED se puede responder otra vez hasta el cierre.
 */
export function admiteRespuesta(
  invitacion: { expiresAt: Date },
  evento: { weddingDate: Date; rsvpDeadlineDays: number },
  ahora: Date,
): boolean {
  return admiteLectura(invitacion, ahora) && ahora.getTime() < cierreRsvp(evento).getTime()
}
