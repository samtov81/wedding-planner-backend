import { Inject, Injectable, Logger } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { ConversacionNoEncontradaError } from '../domain/messaging-errors'
import { encolarAvisoRecibo } from './avisos-mensajeria'
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
 * Devuelve las marcas resultantes y los demás participantes. Tras persistir
 * encola el recibo en tiempo real (`avisos-mensajeria.ts`); si Redis falla se
 * registra un `warn` y la respuesta no cambia.
 */
@Injectable()
export class MarkConversationUseCase {
  private readonly registro = new Logger(MarkConversationUseCase.name)

  constructor(
    @Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

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

    await encolarAvisoRecibo(this.cola, this.registro, { conversationId, userId }, marcas)
    const participantes = await this.repo.participantes(conversationId)
    return { conversationId, marcas, destinatarios: participantes.filter((p) => p !== userId) }
  }
}
