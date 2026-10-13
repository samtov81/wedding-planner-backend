import { Inject, Injectable } from '@nestjs/common'

import { ObjetoNoEncontradoError } from '../domain/seating-errors'
import { SEATING_REPOSITORY, type SeatingRepository } from './seating.repository'

@Injectable()
export class DeleteObjectUseCase {
  constructor(@Inject(SEATING_REPOSITORY) private readonly repo: SeatingRepository) {}

  async ejecutar(eventId: string, id: string): Promise<void> {
    if (!(await this.repo.eliminarObjeto(eventId, id))) throw new ObjetoNoEncontradoError()
  }
}
