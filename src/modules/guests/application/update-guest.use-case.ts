import { Inject, Injectable } from '@nestjs/common'

import type { Guest } from '../domain/guest'
import { InvitadoNoEncontradoError } from '../domain/guest-errors'
import { GUEST_REPOSITORY, type CambiosInvitado, type GuestRepository } from './guest.repository'

@Injectable()
export class UpdateGuestUseCase {
  constructor(@Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository) {}

  async ejecutar(eventId: string, guestId: string, cambios: CambiosInvitado): Promise<Guest> {
    // Existencia comprobada ANTES de escribir: un `updateMany` filtrado por
    // (id, eventId) sobre una fila ajena afectaría a cero filas y respondería
    // 200 sin haber cambiado nada — un éxito que no lo es.
    const existente = await this.invitados.buscar(eventId, guestId)
    if (existente === null) throw new InvitadoNoEncontradoError()

    return await this.invitados.actualizar(eventId, guestId, cambios)
  }
}
