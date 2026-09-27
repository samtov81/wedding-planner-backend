import { InvitacionNoValidaError, RsvpCerradoError } from '../domain/guest-errors'
import { admiteLectura, admiteRespuesta, hashDeToken } from '../domain/invitation'
import type { InvitacionCompleta, InvitationRepository } from './invitation.repository'

/**
 * Entradas del RSVP público: token en claro → invitación, o error. Son dos
 * porque leer y responder ya no exigen lo mismo (bloque A §2), pero la de
 * responder se construye SOBRE la de leer: no puede existir un token que sirva
 * para responder y no para leer.
 *
 * Se busca por el hash (el mismo `hashDeToken` con el que la Tarea 12 lo
 * guardó), nunca por el token: el token en claro no está en la base de datos.
 */

/**
 * GET: token vivo en cualquier estado.
 *
 * Inexistente y caducado (también el caducado por el worker, C18, o por un
 * reenvío, C24) acaban en la MISMA rama y en el mismo error: quien llama no
 * puede distinguir cuál le ha tocado.
 */
export async function buscarInvitacionLegible(
  invitaciones: InvitationRepository,
  token: string,
  ahora: Date,
): Promise<InvitacionCompleta> {
  const invitacion = await invitaciones.buscarPorHash(hashDeToken(token))
  if (invitacion === null || !admiteLectura(invitacion, ahora)) {
    throw new InvitacionNoValidaError()
  }
  return invitacion
}

/**
 * POST: además, antes del cierre. Un token inexistente o caducado da el mismo
 * 404 que siempre; uno vivo fuera de plazo, `RsvpCerradoError` (422).
 */
export async function buscarInvitacionRespondible(
  invitaciones: InvitationRepository,
  token: string,
  ahora: Date,
): Promise<InvitacionCompleta> {
  const invitacion = await buscarInvitacionLegible(invitaciones, token, ahora)
  if (!admiteRespuesta(invitacion, invitacion.event, ahora)) throw new RsvpCerradoError()
  return invitacion
}
