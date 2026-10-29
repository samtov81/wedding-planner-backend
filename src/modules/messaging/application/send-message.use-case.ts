import { Inject, Injectable } from '@nestjs/common'

import { normalizarCuerpo } from '../domain/conversacion'
import {
  ConversacionNoEncontradaError,
  ConversacionSoloLecturaError,
} from '../domain/messaging-errors'
import {
  CONVERSATION_REPOSITORY,
  type ConversationRepository,
  type MensajeVista,
} from './conversation.repository'

/**
 * Envía un mensaje. Escribir exige que AMBOS participantes tengan acceso hoy:
 * si no (`readOnly`) es un 403. Quien no participa recibe el mismo 404 que con
 * un id inexistente. El cuerpo se normaliza aquí (segunda barrera tras Zod).
 *
 * Devuelve el mensaje y a quién hay que avisar (los demás participantes) para
 * que la Tarea 4 encole el aviso en tiempo real. Este caso de uso NO encola:
 * guardar y avisar son pasos separados, y un fallo de Redis no debe perder el
 * mensaje ya guardado.
 */
@Injectable()
export class SendMessageUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  async ejecutar(
    userId: string,
    conversationId: string,
    texto: string,
  ): Promise<{ mensaje: MensajeVista; destinatarios: string[] }> {
    const vista = await this.repo.buscar(conversationId, userId)
    if (vista === null) throw new ConversacionNoEncontradaError()
    if (vista.readOnly) throw new ConversacionSoloLecturaError()

    const cuerpo = normalizarCuerpo(texto)
    const mensaje = await this.repo.agregarMensaje(conversationId, userId, cuerpo, new Date())
    const participantes = await this.repo.participantes(conversationId)
    return { mensaje, destinatarios: participantes.filter((p) => p !== userId) }
  }
}
