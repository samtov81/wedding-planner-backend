import { Inject, Injectable } from '@nestjs/common'

import type { Event } from '../domain/event'
import { EVENT_REPOSITORY, type DatosNuevoEvento, type EventRepository } from './event.repository'

/** Se reexporta el tipo del puerto: el caso de uso no añade nada propio. */
export type DatosCrearEvento = DatosNuevoEvento

@Injectable()
export class CreateEventUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  /**
   * Quien crea el evento es su PLANNER (además de OWNER): la pareja entra
   * después, invitada. Antes nacía COUPLE; los eventos ya creados conservan
   * ese rol a propósito —sin migración de datos— y en ellos el estado del
   * cronograma sólo lo mueve un planner invitado o ADMIN
   * (`esPlannerDelEvento`).
   *
   * El evento y la membresía PLANNER del creador nacen juntos, en una sola
   * transacción: un evento sin membresía es un evento al que ni su dueño puede
   * entrar —`EventAccessService` mira membresías, no `ownerId`— y que nadie
   * puede arreglar salvo a mano contra la base de datos.
   *
   * Nace en DRAFT; solo `name` es obligatorio.
   */
  async ejecutar(datos: DatosCrearEvento): Promise<Event> {
    return await this.eventos.crearConMembresia(datos)
  }
}
