import { Inject, Injectable } from '@nestjs/common'

import { MesaNoEncontradaError } from '../domain/seating-errors'
import { SEATING_REPOSITORY, type SeatingRepository } from './seating.repository'

@Injectable()
export class DeleteTableUseCase {
  constructor(@Inject(SEATING_REPOSITORY) private readonly repo: SeatingRepository) {}

  /** Sus ocupantes quedan sin asignar (las asignaciones caen en cascada). */
  async ejecutar(eventId: string, tableId: string): Promise<void> {
    if (!(await this.repo.eliminarMesa(eventId, tableId))) throw new MesaNoEncontradaError()
  }
}
