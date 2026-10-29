import { Inject, Injectable } from '@nestjs/common'

import {
  CONVERSATION_REPOSITORY,
  type ConversacionVista,
  type ConversationRepository,
} from './conversation.repository'

/** La bandeja de `userId`: sus conversaciones visibles y el total sin leer. */
@Injectable()
export class ListConversationsUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  ejecutar(userId: string): Promise<{ items: ConversacionVista[]; unreadTotal: number }> {
    return this.repo.bandeja(userId)
  }
}
