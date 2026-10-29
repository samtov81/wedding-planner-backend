import { Inject, Injectable } from '@nestjs/common'

import { ConversacionNoEncontradaError } from '../domain/messaging-errors'
import {
  CONVERSATION_REPOSITORY,
  type ConversationRepository,
  type MarcasDeParticipante,
} from './conversation.repository'

/**
 * Marca "entregado" o "leído" hasta el mensaje `upTo`. Las marcas sólo avanzan
 * (lo garantiza el repositorio). Marcar SÍ se permite en solo lectura: leer
 * lo que ya existe no es escribir. Un `upTo` de otra conversación es un 404,
 * igual que una conversación ajena.
 *
 * Devuelve las marcas resultantes y los demás participantes para que la Tarea 4
 * les avise; este caso de uso no encola nada.
 */
@Injectable()
export class MarkConversationUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  async ejecutar(
    userId: string,
    conversationId: string,
    tipo: 'delivered' | 'read',
    upTo: string,
  ): Promise<{
    conversationId: string
    marcas: MarcasDeParticipante
    destinatarios: string[]
  }> {
    const vista = await this.repo.buscar(conversationId, userId)
    if (vista === null) throw new ConversacionNoEncontradaError()

    const marcas = await this.repo.marcar(conversationId, userId, tipo, upTo)
    if (marcas === false) throw new ConversacionNoEncontradaError()

    const participantes = await this.repo.participantes(conversationId)
    return { conversationId, marcas, destinatarios: participantes.filter((p) => p !== userId) }
  }
}
