import { Inject, Injectable } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'

import { AsientoFueraDeRangoError, MesaNoEncontradaError } from '../domain/seating-errors'
import { SEATING_REPOSITORY, type SeatingRepository } from './seating.repository'

@Injectable()
export class ClearSeatUseCase {
  constructor(
    @Inject(SEATING_REPOSITORY) private readonly repo: SeatingRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
  ) {}

  /** Vaciar un asiento ya vacío no es un error: el resultado pedido ya se cumple. */
  async ejecutar(eventId: string, tableId: string, seatIndex: number): Promise<void> {
    await this.unidadDeTrabajo.ejecutar(async () => {
      await this.repo.bloquearEvento(eventId)
      const mesa = await this.repo.buscarMesa(eventId, tableId)
      if (mesa === null) throw new MesaNoEncontradaError()
      if (seatIndex >= mesa.seatCount) throw new AsientoFueraDeRangoError()
      await this.repo.quitarAsiento(eventId, tableId, seatIndex)
    })
  }
}
