import { Inject, Injectable } from '@nestjs/common'

import type { Guest } from '../domain/guest'
import { InvitadoNoEncontradoError } from '../domain/guest-errors'
import { GUEST_REPOSITORY, type GuestRepository } from './guest.repository'

/**
 * DESIGN-GAP: el brief lista cinco casos de uso pero también pide la ruta
 * `GET /:guestId`. Resolver ahí mismo la búsqueda desde el controlador
 * rompería la regla de dependencia (el controlador ensambla, no decide), así
 * que se añade este caso de uso mínimo — mismo precedente que
 * `UpdateEventVendorUseCase` en la Tarea 10.
 */
@Injectable()
export class GetGuestUseCase {
  constructor(@Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository) {}

  async ejecutar(eventId: string, guestId: string): Promise<Guest> {
    const invitado = await this.invitados.buscar(eventId, guestId)
    if (invitado === null) throw new InvitadoNoEncontradoError()
    return invitado
  }
}
