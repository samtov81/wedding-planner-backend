import { Inject, Injectable, Logger } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { normalizarCuerpo } from '../domain/conversacion'
import {
  ConversacionNoEncontradaError,
  ConversacionSoloLecturaError,
} from '../domain/messaging-errors'
import { encolarAvisoMensaje } from './avisos-mensajeria'
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
 * Devuelve el mensaje y los demás participantes. Tras guardar, ENCOLA el aviso
 * en tiempo real (`avisos-mensajeria.ts`): guardar y avisar son pasos separados
 * y un fallo de Redis se registra pero no deshace ni falla un mensaje ya
 * guardado (la respuesta REST no cambia). El worker decide a quién emitir.
 *
 * Nota: `createdAt` sale del reloj del servidor de la API. Con pods desfasados,
 * un mensaje podría ordenarse antes de una marca ya existente (raro). El arreglo
 * sería una marca de tiempo del lado de la base, bajo un bloqueo de fila.
 */
@Injectable()
export class SendMessageUseCase {
  private readonly registro = new Logger(SendMessageUseCase.name)

  constructor(
    @Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

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
    await encolarAvisoMensaje(this.cola, this.registro, { conversationId, messageId: mensaje.id })
    const participantes = await this.repo.participantes(conversationId)
    return { mensaje, destinatarios: participantes.filter((p) => p !== userId) }
  }
}
