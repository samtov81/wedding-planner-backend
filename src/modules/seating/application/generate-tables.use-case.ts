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
import { leerDistribucion } from './get-seating.use-case'
import { SEATING_REPOSITORY, type SeatingRepository } from './seating.repository'

export interface EntradaGenerarMesas {
  count: number
  minSeats: number
  maxSeats: number
}

/**
 * Agrega `count` mesas a continuación de las que ya hay ("Mesa 6", "Mesa 7"…),
 * cada una con `minSeats` asientos, en la cuadrícula tras la última.
 */
@Injectable()
export class GenerateTablesUseCase {
  constructor(
    @Inject(SEATING_REPOSITORY) private readonly repo: SeatingRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
  ) {}

  async ejecutar(eventId: string, entrada: EntradaGenerarMesas): Promise<MesaVista[]> {
    const { count, minSeats, maxSeats } = entrada
    if (!rangoAsientosValido({ minSeats, seatCount: minSeats, maxSeats })) {
      throw new RangoDeAsientosInvalidoError()
    }
    return await this.unidadDeTrabajo.ejecutar(async () => {
      await this.repo.bloquearEvento(eventId)
      const existentes = await this.repo.contarMesas(eventId)
      if (existentes + count > MAX_MESAS_POR_EVENTO) throw new LimiteDeMesasError()
      await this.repo.crearMesas(
        eventId,
        Array.from({ length: count }, (_, i) => ({
          name: nombrePorDefecto(existentes + i + 1),
          minSeats,
          maxSeats,
          seatCount: minSeats,
          ...posicionEnCuadricula(existentes + i),
        })),
      )
      return await leerDistribucion(this.repo, eventId)
    })
  }
}
