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

    // Escritura condicional: entre el check de arriba y aquí, un PATCH
    // concurrente puede haber vaciado `venue` o `totalBudget` (por ejemplo,
    // otra pestaña). `publicarSiCompleto` sólo aplica el ACTIVE si en ese
    // mismo instante el evento sigue completo; si no, se relee y se repite la
    // validación para dar el motivo correcto en vez de dejar un ACTIVE a medias.
    const publicado = await this.eventos.publicarSiCompleto(eventId)
    if (publicado !== null) return publicado

    const actualizado = await this.eventos.buscarPorId(eventId)
    if (actualizado === null) throw new EventoNoEncontradoError()
    if (actualizado.status === 'ACTIVE') return actualizado
    throw new EventoIncompletoError(camposFaltantesParaPublicar(actualizado))
  }
}
