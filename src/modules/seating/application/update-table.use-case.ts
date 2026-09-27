import { Inject, Injectable } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'

import { type MesaVista, rangoAsientosValido } from '../domain/seating'
import {
  AsientoOcupadoError,
  MesaNoEncontradaError,
  RangoDeAsientosInvalidoError,
} from '../domain/seating-errors'
import { leerDistribucion } from './get-seating.use-case'
import { type CambiosMesa, SEATING_REPOSITORY, type SeatingRepository } from './seating.repository'

@Injectable()
export class UpdateTableUseCase {
  constructor(
    @Inject(SEATING_REPOSITORY) private readonly repo: SeatingRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
  ) {}

  /**
   * El rango se valida contra lo guardado: un PATCH puede traer solo `maxSeats`.
   * Bajar `seatCount` quita los últimos asientos, y solo si están vacíos.
   */
  async ejecutar(eventId: string, tableId: string, cambios: CambiosMesa): Promise<MesaVista> {
    return await this.unidadDeTrabajo.ejecutar(async () => {
      await this.repo.bloquearEvento(eventId)
      const actual = await this.repo.buscarMesa(eventId, tableId)
      if (actual === null) throw new MesaNoEncontradaError()
      const seatCount = cambios.seatCount ?? actual.seatCount
      const rango = {
        minSeats: cambios.minSeats ?? actual.minSeats,
        seatCount,
        maxSeats: cambios.maxSeats ?? actual.maxSeats,
      }
      if (!rangoAsientosValido(rango)) throw new RangoDeAsientosInvalidoError()
      if (seatCount < actual.seatCount) {
        const asignaciones = await this.repo.listarAsignaciones(eventId)
        if (asignaciones.some((a) => a.tableId === tableId && a.seatIndex >= seatCount)) {
          throw new AsientoOcupadoError()
        }
      }
      await this.repo.actualizarMesa(eventId, tableId, cambios)
      const mesa = (await leerDistribucion(this.repo, eventId)).find((m) => m.id === tableId)
      if (mesa === undefined) throw new MesaNoEncontradaError()
      return mesa
    })
  }
}
