import { Inject, Injectable } from '@nestjs/common'

import type { Event } from '../domain/event'
import { EVENT_REPOSITORY, type EventRepository } from './event.repository'

@Injectable()
export class ListEventsUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  /**
   * Las dos fuentes de acceso, otra vez: membresías ACTIVE y contrataciones
   * BOOKED. Es la misma regla que aplica `EventAccessService` a un evento
   * suelto; si divergieran, un vendor vería un evento en su lista y recibiría
   * un 404 al abrirlo.
   */
  async ejecutar(userId: string): Promise<Event[]> {
    return await this.eventos.listarAccesiblesPor(userId)
  }
}
