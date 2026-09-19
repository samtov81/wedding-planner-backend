import { Inject, Injectable } from '@nestjs/common'

import type { RsvpStatus } from '../domain/guest'
import { InvitacionNoValidaError } from '../domain/guest-errors'
import { cierreRsvp } from '../domain/invitation'
import { GUEST_REPOSITORY, type GuestRepository } from './guest.repository'
import { buscarInvitacionLegible } from './invitacion-valida'
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
  /**
   * ISO 8601. Desde este instante el POST responde `RSVP_CLOSED`; antes, el
   * invitado puede cambiar su respuesta (bloque A §2).
   */
  rsvpClosesAt: string
}

@Injectable()
export class GetRsvpUseCase {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly invitaciones: InvitationRepository,
    @Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository,
  ) {}

  /**
   * La lectura sólo exige un token vivo (`admiteLectura`): sirve en cualquier
   * estado, también ya respondida y también pasado el cierre.
   *
   * DESIGN-GAP: la spec original rechazaba leer con un token ya usado (un
   * enlace respondido no debía ser una llave de 90 días a nombre, boda y fecha
   * de alguien). La decisión del usuario del bloque A §2 lo invierte: el
   * invitado reabre el enlace, ve lo que contestó y cuándo cierra el plazo
   * (`rsvpClosesAt`), y puede cambiarlo. Coste asumido: el enlace da lectura
   * hasta que caduca. Lo acota la caducidad: `caducarVigentesDe` (C24) mata
   * también los tokens RESPONDED al reenviar o al cambiar el email.
   *
   * La vista se construye campo a campo, no con un spread de la fila: un campo
   * nuevo en el invitado o el evento no puede colarse en la respuesta pública.
   */
  async ejecutar(token: string): Promise<VistaPublicaRsvp> {
    const invitacion = await buscarInvitacionLegible(this.invitaciones, token, new Date())

    const invitado = await this.invitados.buscar(invitacion.guest.eventId, invitacion.guest.id)
    if (invitado === null) throw new InvitacionNoValidaError()

    return {
      guestName: invitado.name,
      eventName: invitacion.event.name,
      weddingDate: invitacion.event.weddingDate.toISOString(),
      rsvp: invitado.rsvp,
      dietary: invitado.dietary,
      rsvpClosesAt: cierreRsvp(invitacion.event).toISOString(),
    }
  }
}
