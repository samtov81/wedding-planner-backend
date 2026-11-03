import { Inject, Injectable } from '@nestjs/common'

import { lectoresDe } from '../domain/sala'
import { ConversacionNoEncontradaError } from '../domain/messaging-errors'
import {
  CONVERSATION_REPOSITORY,
  type Contacto,
  type ConversationRepository,
} from './conversation.repository'

/**
 * Quién leyó y quién no un mensaje MÍO de la sala, entre sus destinatarios
 * fijados al enviarlo (sólo nombres: no se guarda la hora de cada lectura).
 * Sólo el remitente puede preguntarlo; a cualquier otro, y para un mensaje
 * que no es de una sala que vea, 404 (no confirma que exista).
 */
@Injectable()
export class ListRoomReadersUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  async ejecutar(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<{ read: Contacto[]; unread: Contacto[] }> {
    const sala = await this.repo.buscarSala(conversationId, userId)
    if (sala === null) throw new ConversacionNoEncontradaError()
    const mensaje = await this.repo.mensaje(conversationId, messageId)
    if (mensaje === null || mensaje.senderId !== userId) throw new ConversacionNoEncontradaError()

    const [destinatarios, marcas] = await Promise.all([
      this.repo.destinatariosDe([messageId]),
      this.repo.marcasDeSala(conversationId),
    ])
    const porId = new Map(marcas.map((m) => [m.userId, m]))
    const { read, unread } = lectoresDe(destinatarios.get(messageId) ?? [], porId, {
      at: mensaje.createdAt,
      id: mensaje.id,
    })
    const contacto = (id: string): Contacto[] => {
      const m = porId.get(id)
      return m === undefined ? [] : [{ userId: id, displayName: m.displayName, role: m.role }]
    }
    return { read: read.flatMap(contacto), unread: unread.flatMap(contacto) }
  }
}
