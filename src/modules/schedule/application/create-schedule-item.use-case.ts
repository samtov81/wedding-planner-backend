import { Inject, Injectable } from '@nestjs/common'

import {
  CambioDeEstadoNoPermitidoError,
  RangoDeCronogramaInvalidoError,
} from '../domain/schedule-errors'
import { rangoValido, type ScheduleItem } from '../domain/schedule-item'
import {
  type DatosNuevoItem,
  SCHEDULE_ITEM_REPOSITORY,
  type ScheduleItemRepository,
} from './schedule-item.repository'
import type { ActorDelCronograma } from './update-schedule-item.use-case'

export type EntradaNuevoItem = Omit<DatosNuevoItem, 'eventId' | 'status'> & {
  status?: DatosNuevoItem['status'] | undefined
}

@Injectable()
export class CreateScheduleItemUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  /**
   * Quien no puede cambiar estados sí crea ítems, pero sólo en PENDING (el
   * de por defecto): crear uno ya en DONE es cambiarle el estado por otra
   * puerta. Mandar `PENDING` explícito se acepta porque no decide nada.
   */
  async ejecutar(
    eventId: string,
    entrada: EntradaNuevoItem,
    actor: ActorDelCronograma,
  ): Promise<ScheduleItem> {
    const status = entrada.status ?? 'PENDING'
    if (status !== 'PENDING' && !actor.puedeCambiarEstado) {
      throw new CambioDeEstadoNoPermitidoError()
    }
    if (!rangoValido(entrada.startsAt, entrada.endsAt)) throw new RangoDeCronogramaInvalidoError()
    return await this.items.crear({ ...entrada, eventId, status })
  }
}
