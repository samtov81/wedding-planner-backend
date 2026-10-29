import { Inject, Injectable } from '@nestjs/common'

import { SinAccesoAlEventoError } from '../domain/messaging-errors'
import {
  type Contacto,
  CONVERSATION_REPOSITORY,
  type ConversationRepository,
} from './conversation.repository'

/**
 * Con quién puede hablar `userId` en el evento. Sin acceso hoy es un 403
 * explícito (no una lista vacía) para que el cliente distinga "no hay nadie"
 * de "no puedes estar aquí".
 */
@Injectable()
export class ListContactsUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  async ejecutar(userId: string, eventId: string): Promise<Contacto[]> {
    if ((await this.repo.rolEnEvento(eventId, userId)) === null) throw new SinAccesoAlEventoError()
    return this.repo.contactos(eventId, userId)
  }
}
