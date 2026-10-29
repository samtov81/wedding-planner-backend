import { Inject, Injectable } from '@nestjs/common'

import type { CursorPage, CursorValue } from '@/shared/domain'

import { ConversacionNoEncontradaError } from '../domain/messaging-errors'
import {
  CONVERSATION_REPOSITORY,
  type ConversacionVista,
  type ConversationRepository,
  type MensajeVista,
} from './conversation.repository'

/**
 * Una página de mensajes (más recientes primero) más las marcas del otro, para
 * pintar "entregado" y "leído". Una conversación ajena o invisible es un 404
 * idéntico al de un id inexistente. Se puede leer en solo lectura.
 */
@Injectable()
export class ListMessagesUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  async ejecutar(
    userId: string,
    conversationId: string,
    opciones: { desde: CursorValue | null; limite: number },
  ): Promise<{ pagina: CursorPage<MensajeVista>; otherMarks: ConversacionVista['otherMarks'] }> {
    const vista = await this.repo.buscar(conversationId, userId)
    if (vista === null) throw new ConversacionNoEncontradaError()
    const pagina = await this.repo.mensajes(conversationId, opciones)
    return { pagina, otherMarks: vista.otherMarks }
  }
}
