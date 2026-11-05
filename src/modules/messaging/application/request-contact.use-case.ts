import { Inject, Injectable, Logger } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { normalizarCuerpo } from '../domain/conversacion'
import { AutocontactoError, FichaNoDisponibleError } from '../domain/messaging-errors'
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
 * `tienenRelacion` (que con `a === b` da false: el 422 lo decide este caso de
 * uso, no el resultado de la relación); cuerpo
 * normalizado (segunda barrera tras Zod, y falla antes de crear nada); y
 * `solicitar`, que en UNA transacción evalúa las reglas del par y guarda la
 * conversación y el mensaje (lanza sus errores de dominio).
 *
 * Tras confirmar, ENCOLA dos avisos (`message.created` y `contact.updated`): un
 * fallo de Redis se registra y no deshace lo guardado (ver `avisos-mensajeria`).
 * Alternativa descartada: un solo aviso que llevara todo; el cliente ya sabe
 * tratar `message.created` y el estado de la solicitud es otro evento.
 *
 * Los avisos se encolan ANTES de leer la vista y con el `estado` que devuelve
 * `solicitar`: lo guardado ya está confirmado y el otro debe enterarse pase lo
 * que pase después. Que el solicitante no vea la conversación que acaba de
 * crear es imposible (`veConversacionDePerfil` siempre le deja verla): si
 * ocurre, es un error de invariante (500), no un 404 de dominio que le diría
 * al cliente que no existe algo que sí se guardó.
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
    const { conversationId, mensaje, estado } = await this.repo.solicitar({
      solicitante: userId,
      ficha,
      cuerpo,
      relacionados,
      ahora: new Date(),
    })

    await encolarAvisoMensaje(this.cola, this.registro, { conversationId, messageId: mensaje.id })
    await encolarAvisoContacto(this.cola, this.registro, {
      conversationId,
      estado,
      mensajeId: mensaje.id,
    })
    const conversacion = await this.repo.buscarPerfil(conversationId, userId)
    if (conversacion === null) {
      throw new Error(
        `invariante rota: el solicitante no ve la conversación ${conversationId} que creó`,
      )
    }
    return { conversacion, mensaje }
  }
}
