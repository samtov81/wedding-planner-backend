import { Inject, Injectable } from '@nestjs/common'

import {
  CONVERSATION_REPOSITORY,
  type ConversationRepository,
  type SalaVista,
} from './conversation.repository'

/**
 * Las salas de `userId` con su propio `unreadTotal`. Van aparte de la bandeja
 * 1:1 (`GET /me/conversations`) a propósito: el frontend de la parte 1 valida
 * esa respuesta exigiendo `other` y un elemento de sala la rompería entera.
 */
@Injectable()
export class ListRoomsUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  ejecutar(userId: string): Promise<{ items: SalaVista[]; unreadTotal: number }> {
    return this.repo.salas(userId)
  }
}
