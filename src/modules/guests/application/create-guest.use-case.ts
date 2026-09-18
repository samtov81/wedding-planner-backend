import { Inject, Injectable } from '@nestjs/common'

import type { Guest } from '../domain/guest'
import { GUEST_REPOSITORY, type DatosCrearInvitado, type GuestRepository } from './guest.repository'

@Injectable()
export class CreateGuestUseCase {
  constructor(@Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository) {}

  /**
   * El `eventId` llega aparte del resto de datos a propósito: viene de la ruta
   * —que el guard ya autorizó—, nunca del cuerpo. Si viniera del cuerpo, un
   * cliente podría crear invitados en un evento al que sí tiene acceso pero
   * apuntando a otro.
   */
  async ejecutar(eventId: string, datos: Omit<DatosCrearInvitado, 'eventId'>): Promise<Guest> {
    return await this.invitados.crear({ ...datos, eventId })
  }
}
