import { Inject, Injectable } from '@nestjs/common'

import { resumirPorEstado, type GuestSummary } from '../domain/guest'
import { GUEST_REPOSITORY, type GuestRepository } from './guest.repository'

/**
 * El resumen sale de un GROUP BY sobre las filas y se compone en el dominio
 * (`resumirPorEstado`). No hay —ni debe haber— columna de contador: el
 * invariante `total === confirmed + pending + declined` se cumple por
 * construcción, no por disciplina de quien escriba el siguiente endpoint.
 */
@Injectable()
export class GuestSummaryUseCase {
  constructor(@Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository) {}

  async ejecutar(eventId: string): Promise<GuestSummary> {
    return resumirPorEstado(await this.invitados.contarPorEstado(eventId))
  }
}
