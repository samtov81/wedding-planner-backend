import { InvitacionNoValidaError } from '../domain/guest-errors'
import { admiteRespuesta, hashDeToken } from '../domain/invitation'
import type { InvitacionCompleta, InvitationRepository } from './invitation.repository'

/**
 * Entrada ÚNICA del RSVP público: token en claro → invitación que todavía
 * admite respuesta, o `InvitacionNoValidaError`. La comparten la lectura y la
 * respuesta para que no pueda existir un token que valga en una y no en otra.
 *
 * Se busca por el hash (el mismo `hashDeToken` con el que la Tarea 12 lo
 * guardó), nunca por el token: el token en claro no está en la base de datos.
 *
 * Inexistente, caducado y ya usado acaban en la MISMA rama y en el mismo error:
 * no hay forma de que quien llama distinga cuál de los tres le ha tocado.
 */
export async function buscarInvitacionValida(
  invitaciones: InvitationRepository,
  token: string,
  ahora: Date,
): Promise<InvitacionCompleta> {
  const invitacion = await invitaciones.buscarPorHash(hashDeToken(token))
  if (invitacion === null || !admiteRespuesta(invitacion, ahora)) {
    throw new InvitacionNoValidaError()
  }
  return invitacion
}
