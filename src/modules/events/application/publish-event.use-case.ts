import { Inject, Injectable } from '@nestjs/common'

import type { Event } from '../domain/event'
import { EventoIncompletoError, EventoNoEncontradoError } from '../domain/event-errors'
import { camposFaltantesParaPublicar } from '../domain/publicacion'
import { EVENT_REPOSITORY, type EventRepository } from './event.repository'

@Injectable()
export class PublishEventUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  /** DRAFT → ACTIVE. Sobre un ACTIVE no hace nada: reintentar no es un error. */
  async ejecutar(eventId: string): Promise<Event> {
    const actual = await this.eventos.buscarPorId(eventId)
    if (actual === null) throw new EventoNoEncontradoError()
    if (actual.status === 'ACTIVE') return actual

    const faltantes = camposFaltantesParaPublicar(actual)
    if (faltantes.length > 0) throw new EventoIncompletoError(faltantes)

    return await this.eventos.actualizar(eventId, { status: 'ACTIVE' })
  }
}
