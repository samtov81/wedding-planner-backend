import { Inject, Injectable } from '@nestjs/common'

import { SalaNoDisponibleError } from '../domain/messaging-errors'
import {
  CONVERSATION_REPOSITORY,
  type ConversationRepository,
  type SalaVista,
} from './conversation.repository'

/**
 * La sala del evento para `userId`. Un miembro ACTIVE la crea si aún no
 * existe (para él "estaba ahí desde el principio"); un miembro que salió la
 * recibe en solo lectura; un proveedor, un admin sin membresía o alguien sin
 * relación, 403 `ROOM_ACCESS_DENIED`. Un 403 y no un 404: el evento es
 * conocido por id y decir "esta sala no es para ti" no filtra nada nuevo.
 */
@Injectable()
export class OpenRoomUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  async ejecutar(userId: string, eventId: string): Promise<SalaVista> {
    const id = await this.repo.abrirSala(eventId, userId)
    const vista = id === null ? null : await this.repo.buscarSala(id, userId)
    if (vista === null) throw new SalaNoDisponibleError()
    return vista
  }
}
