import { Inject, Injectable } from '@nestjs/common'

import type { ObjetoDeSala } from '../domain/seating'
import {
  type CambiosObjeto,
  SEATING_REPOSITORY,
  type SeatingRepository,
} from './seating.repository'

@Injectable()
export class UpdateObjectUseCase {
  constructor(@Inject(SEATING_REPOSITORY) private readonly repo: SeatingRepository) {}

  /** Mover o renombrar. El tipo (`kind`) no se cambia: para otro tipo, se borra y se crea. */
  async ejecutar(eventId: string, id: string, cambios: CambiosObjeto): Promise<ObjetoDeSala> {
    return await this.repo.actualizarObjeto(eventId, id, cambios)
  }
}
