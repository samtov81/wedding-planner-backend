import { Inject, Injectable, Logger } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import {
  ConversacionNoEncontradaError,
  SolicitudNoPendienteError,
} from '../domain/messaging-errors'
import { encolarAvisoContacto } from './avisos-mensajeria'
import {
  CONVERSATION_REPOSITORY,
  type ConversacionDePerfilVista,
  type ConversationRepository,
} from './conversation.repository'

/**
 * El proveedor acepta o rechaza una solicitud (spec 2026-11-03 §4.2). El
 * repositorio decide en una transacción: `no-encontrada` (no es `PROFILE` o
 * quien responde no es el proveedor, mismo 404 que un id ajeno) y
 * `no-pendiente` (409: ya se respondió). Si responde, devuelve la vista del
 * proveedor y encola `contact.updated`; sin mensaje nuevo, `mensajeId` es null.
 * Un fallo de Redis se registra pero no deshace la decisión. Al RECHAZAR el
 * proveedor deja de ver la conversación, así que la respuesta es la vista
 * previa con el estado nuevo; alternativa descartada: devolver 404 tras un
 * rechazo que sí se guardó.
 */
@Injectable()
export class RespondContactUseCase {
  private readonly registro = new Logger(RespondContactUseCase.name)

  constructor(
    @Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(
    userId: string,
    conversationId: string,
    decision: 'ACCEPTED' | 'DECLINED',
  ): Promise<ConversacionDePerfilVista> {
    // Se lee ANTES: tras rechazar, el proveedor ya no la ve y `buscarPerfil`
    // devolvería null (`veConversacionDePerfil`).
    const antes = await this.repo.buscarPerfil(conversationId, userId)
    if (antes === null) throw new ConversacionNoEncontradaError()
    const r = await this.repo.responder(conversationId, userId, decision, new Date())
    if (r === 'no-encontrada') throw new ConversacionNoEncontradaError()
    if (r === 'no-pendiente') throw new SolicitudNoPendienteError()

    await encolarAvisoContacto(this.cola, this.registro, {
      conversationId,
      estado: decision,
      mensajeId: null,
    })
    if (decision === 'DECLINED') return { ...antes, status: 'DECLINED', readOnly: true }
    return (await this.repo.buscarPerfil(conversationId, userId)) ?? { ...antes, status: decision }
  }
}
