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
 * `no-pendiente` (409: ya se respondió). Un proveedor que ya rechazó no ve la
 * conversación y aun así recibe 409, no 404 (spec §4.2), porque el repositorio
 * mira la fila, no la visibilidad.
 *
 * Si responde, `responder` devuelve la vista del proveedor leída DENTRO de la
 * transacción, tras la transición (en un rechazo, `DECLINED` y en solo
 * lectura), y se encola `contact.updated` SIEMPRE; sin mensaje nuevo,
 * `mensajeId` es null. Un fallo de Redis se registra pero no deshace la
 * decisión. Alternativa descartada (la versión anterior): leer la vista con
 * `buscarPerfil` ANTES de responder. Esa lectura quedaba fuera de la
 * transacción: si el proveedor que ya había rechazado respondía mientras el
 * solicitante reintentaba pasadas las 24 h, la lectura previa era null, la
 * respuesta salía `ok` y el caso de uso fallaba con un 500 sin encolar el aviso.
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
    const vista = await this.repo.responder(conversationId, userId, decision, new Date())
    if (vista === 'no-encontrada') throw new ConversacionNoEncontradaError()
    if (vista === 'no-pendiente') throw new SolicitudNoPendienteError()

    await encolarAvisoContacto(this.cola, this.registro, {
      conversationId,
      estado: decision,
      mensajeId: null,
    })
    return vista
  }
}
