import { Inject, Injectable } from '@nestjs/common'

import type { RsvpStatus } from '../domain/guest'
import { InvitacionNoValidaError } from '../domain/guest-errors'
import { GUEST_REPOSITORY, type GuestRepository } from './guest.repository'
import { buscarInvitacionValida } from './invitacion-valida'
import { INVITATION_REPOSITORY, type InvitationRepository } from './invitation.repository'

/**
 * Lo ÚNICO que ve quien abre el enlace. Quien tiene el token no está
 * autenticado — el correo se reenvía, se imprime, se queda en un móvil ajeno —,
 * así que no hay ids (ni del invitado, ni del evento, ni de la invitación), ni
 * correos, ni el grupo, ni nada de los demás invitados.
 */
export interface VistaPublicaRsvp {
  guestName: string
  eventName: string
  /** ISO 8601, como el resto de fechas de la API. */
  weddingDate: string
  rsvp: RsvpStatus
  dietary: string | null
}

@Injectable()
export class GetRsvpUseCase {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly invitaciones: InvitationRepository,
    @Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository,
  ) {}

  /**
   * La lectura exige el MISMO token válido que la respuesta: un token ya usado
   * tampoco sirve para leer.
   *
   * DESIGN-GAP: el brief pide "su estado actual" sin decir qué pasa con un
   * token ya usado. Se rechaza igual que uno inexistente. Dejar leer con un
   * token usado sería un oráculo ("este token existió") y, peor, convertiría
   * cada enlace respondido en una llave de 90 días a nombre, boda y fecha de
   * alguien. Coste: quien reabre el correo tras contestar ve "no válida" en vez
   * de su respuesta; para cambiarla, la pareja le reenvía la invitación (el
   * envío individual lo permite a propósito, ver `SendSingleInvitationUseCase`).
   *
   * La vista se construye campo a campo, no con un spread de la fila: un campo
   * nuevo en el invitado o el evento no puede colarse en la respuesta pública.
   */
  async ejecutar(token: string): Promise<VistaPublicaRsvp> {
    const invitacion = await buscarInvitacionValida(this.invitaciones, token, new Date())

    const invitado = await this.invitados.buscar(invitacion.guest.eventId, invitacion.guest.id)
    if (invitado === null) throw new InvitacionNoValidaError()

    return {
      guestName: invitado.name,
      eventName: invitacion.event.name,
      weddingDate: invitacion.event.weddingDate.toISOString(),
      rsvp: invitado.rsvp,
      dietary: invitado.dietary,
    }
  }
}
