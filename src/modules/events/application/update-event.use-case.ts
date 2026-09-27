import { Inject, Injectable } from '@nestjs/common'

import type { Event } from '../domain/event'
import { EventoIncompletoError, EventoNoEncontradoError } from '../domain/event-errors'
import { camposFaltantesParaPublicar } from '../domain/publicacion'
import { type CambiosEvento, EVENT_REPOSITORY, type EventRepository } from './event.repository'

@Injectable()
export class UpdateEventUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  /**
   * Un evento es editable en CUALQUIER estado (decisión del usuario). La única
   * guarda: un ACTIVE no puede quedar sin algo que antes tenía y que hace falta
   * para estar publicado. Se comparan los faltantes de antes y de después para
   * no bloquear la edición de eventos migrados que ya venían sin coordenadas.
   */
  async ejecutar(eventId: string, cambios: CambiosEvento): Promise<Event> {
    const actual = await this.eventos.buscarPorId(eventId)
    if (actual === null) throw new EventoNoEncontradoError()

    if (actual.status === 'ACTIVE') {
      const antes = new Set(camposFaltantesParaPublicar(actual))
      const despues = camposFaltantesParaPublicar({
        name: cambios.name ?? actual.name,
        weddingDate: cambios.weddingDate !== undefined ? cambios.weddingDate : actual.weddingDate,
        timezone: cambios.timezone ?? actual.timezone,
        currency: cambios.currency ?? actual.currency,
        totalBudget: cambios.totalBudget !== undefined ? cambios.totalBudget : actual.totalBudget,
        venue: cambios.venue !== undefined ? cambios.venue : actual.venue,
      })
      const nuevos = despues.filter((campo) => !antes.has(campo))
      if (nuevos.length > 0) throw new EventoIncompletoError(nuevos)
    }

    return await this.eventos.actualizar(eventId, cambios)
  }
}
