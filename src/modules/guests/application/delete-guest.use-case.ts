import { Inject, Injectable } from '@nestjs/common'

import { InvitadoNoEncontradoError } from '../domain/guest-errors'
import { GUEST_REPOSITORY, type GuestRepository } from './guest.repository'

@Injectable()
export class DeleteGuestUseCase {
  constructor(@Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository) {}

  async ejecutar(eventId: string, guestId: string): Promise<void> {
    const existente = await this.invitados.buscar(eventId, guestId)
    if (existente === null) throw new InvitadoNoEncontradoError()

    await this.invitados.borrar(eventId, guestId)
  }
}
