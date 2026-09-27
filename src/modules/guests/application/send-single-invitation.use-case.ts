import { Inject, Injectable } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { GuestHasNoEmailError, InvitadoNoEncontradoError } from '../domain/guest-errors'
import { GUEST_REPOSITORY, type GuestRepository } from './guest.repository'
import { INVITATION_REPOSITORY, type InvitationRepository } from './invitation.repository'
import { encolarInvitacion } from './send-invitations.use-case'

@Injectable()
export class SendSingleInvitationUseCase {
  constructor(
    @Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository,
    @Inject(INVITATION_REPOSITORY) private readonly invitaciones: InvitationRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  /**
   * Aquí sí LANZA lo que el envío masivo omite. Un envío a UNA persona concreta
   * que no puede recibirlo es un fallo de esa petición y el cliente tiene que
   * verlo; en el masivo, el mismo caso es una línea de `skipped`.
   *
   * DESIGN-GAP: el brief no dice qué hacer si el invitado YA respondió. Se
   * permite reenviar: pedirlo para una persona concreta es un acto deliberado
   * (el correo se perdió, quiere cambiar su respuesta), al revés que en el
   * masivo, donde reinvitar a los que ya contestaron es ruido para todos.
   */
  async ejecutar(
    eventId: string,
    guestId: string,
    requestId = '',
  ): Promise<{ guestId: string; invitationId: string }> {
    const invitado = await this.invitados.buscar(eventId, guestId)
    if (invitado === null) throw new InvitadoNoEncontradoError()
    if (invitado.email === null) throw new GuestHasNoEmailError()

    const invitationId = await encolarInvitacion(
      this.invitaciones,
      this.cola,
      invitado.id,
      requestId,
    )

    return { guestId: invitado.id, invitationId }
  }
}
