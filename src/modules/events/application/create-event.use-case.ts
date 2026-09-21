import { Inject, Injectable } from '@nestjs/common'

import type { Event } from '../domain/event'
import { EVENT_REPOSITORY, type EventRepository } from './event.repository'

export interface DatosCrearEvento {
  name: string
  weddingDate: Date
  ownerId: string
  /**
   * Ausente = default de la columna. Admite `undefined` explícito porque es lo
   * que el `.optional()` de Zod entrega desde el borde HTTP.
   */
  rsvpDeadlineDays?: number | undefined
}

@Injectable()
export class CreateEventUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  /**
   * El evento y la membresía COUPLE del creador nacen juntos, en una sola
   * transacción: un evento sin membresía es un evento al que ni su dueño puede
   * entrar —`EventAccessService` mira membresías, no `ownerId`— y que nadie
   * puede arreglar salvo a mano contra la base de datos.
   */
  async ejecutar(datos: DatosCrearEvento): Promise<Event> {
    return await this.eventos.crearConMembresia(datos)
  }
}
