import { Inject, Injectable } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'

import {
  MAX_MESAS_POR_EVENTO,
  type MesaVista,
  nombrePorDefecto,
  posicionEnCuadricula,
  rangoAsientosValido,
} from '../domain/seating'
import { LimiteDeMesasError, RangoDeAsientosInvalidoError } from '../domain/seating-errors'
import { SEATING_REPOSITORY, type SeatingRepository } from './seating.repository'

export interface EntradaNuevaMesa {
  name?: string | undefined
  minSeats: number
  maxSeats: number
}

@Injectable()
export class CreateTableUseCase {
  constructor(
    @Inject(SEATING_REPOSITORY) private readonly repo: SeatingRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
  ) {}

  /** Nace vacía y con `minSeats` asientos. */
  async ejecutar(eventId: string, entrada: EntradaNuevaMesa): Promise<MesaVista> {
    const { minSeats, maxSeats } = entrada
    if (!rangoAsientosValido({ minSeats, seatCount: minSeats, maxSeats })) {
      throw new RangoDeAsientosInvalidoError()
    }
    return await this.unidadDeTrabajo.ejecutar(async () => {
      await this.repo.bloquearEvento(eventId)
      const existentes = await this.repo.contarMesas(eventId)
      if (existentes + 1 > MAX_MESAS_POR_EVENTO) throw new LimiteDeMesasError()
      const [mesa] = await this.repo.crearMesas(eventId, [
        {
          name: entrada.name ?? nombrePorDefecto(existentes + 1),
          minSeats,
          maxSeats,
          seatCount: minSeats,
          ...posicionEnCuadricula(existentes),
        },
      ])
      if (mesa === undefined) throw new Error('crearMesas no devolvió la mesa creada')
      return {
        ...mesa,
        seats: Array.from({ length: mesa.seatCount }, (_, index) => ({ index, occupant: null })),
      }
    })
  }
}
