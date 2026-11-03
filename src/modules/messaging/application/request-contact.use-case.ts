import { Inject, Injectable, Logger } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { normalizarCuerpo } from '../domain/conversacion'
import {
  AutocontactoError,
  ConversacionNoEncontradaError,
  FichaNoDisponibleError,
} from '../domain/messaging-errors'
import { encolarAvisoContacto, encolarAvisoMensaje } from './avisos-mensajeria'
import {
  CONVERSATION_REPOSITORY,
  type ConversacionDePerfilVista,
  type ConversationRepository,
  type MensajeVista,
} from './conversation.repository'

/**
 * Pide contacto con el proveedor dueño de una ficha pública (spec 2026-11-03
 * §3 y §4.2). Orden de las barreras: ficha inexistente o NO publicada → el
 * mismo 404 (un borrador no confirma que exista); autocontacto → 422, ANTES de
 * `tienenRelacion` porque `tienenRelacion(a, a)` puede ser verdadero; cuerpo
 * normalizado (segunda barrera tras Zod, y falla antes de crear nada); y
 * `solicitar`, que en UNA transacción evalúa las reglas del par y guarda la
 * conversación y el mensaje (lanza sus errores de dominio).
 *
 * Tras confirmar, ENCOLA dos avisos (`message.created` y `contact.updated`): un
 * fallo de Redis se registra y no deshace lo guardado (ver `avisos-mensajeria`).
 * Alternativa descartada: un solo aviso que llevara todo; el cliente ya sabe
 * tratar `message.created` y el estado de la solicitud es otro evento.
 */
@Injectable()
export class RequestContactUseCase {
  private readonly registro = new Logger(RequestContactUseCase.name)

  constructor(
    @Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(
    userId: string,
    vendorProfileId: string,
    texto: string,
  ): Promise<{ conversacion: ConversacionDePerfilVista; mensaje: MensajeVista }> {
    const ficha = await this.repo.fichaParaContacto(vendorProfileId)
    if (ficha === null || !ficha.publicada) throw new FichaNoDisponibleError()
    if (ficha.userId === userId) throw new AutocontactoError()
    const cuerpo = normalizarCuerpo(texto)

    const relacionados = await this.repo.tienenRelacion(userId, ficha.userId)
    const { conversationId, mensaje } = await this.repo.solicitar({
      solicitante: userId,
      ficha,
      cuerpo,
      relacionados,
      ahora: new Date(),
    })

    const conversacion = await this.repo.buscarPerfil(conversationId, userId)
    if (conversacion === null) throw new ConversacionNoEncontradaError()
    await encolarAvisoMensaje(this.cola, this.registro, { conversationId, messageId: mensaje.id })
    await encolarAvisoContacto(this.cola, this.registro, {
      conversationId,
      estado: conversacion.status,
      mensajeId: mensaje.id,
    })
    return { conversacion, mensaje }
  }
}
