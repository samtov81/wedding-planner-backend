import { Inject, Injectable } from '@nestjs/common'

import { CONVERSATION_REPOSITORY, type ConversationRepository } from './conversation.repository'

/** Las conversaciones de contacto desde la ficha que ve `userId` (spec 2026-11-03 §4.2). */
@Injectable()
export class ListProfileConversationsUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  ejecutar(userId: string): ReturnType<ConversationRepository['perfiles']> {
    return this.repo.perfiles(userId)
  }
}
