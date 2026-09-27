import { Inject, Injectable } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'

import { type Asignacion, type MesaVista, ocupanteValido } from '../domain/seating'
import {
  AsientoFueraDeRangoError,
  MesaNoEncontradaError,
  OcupanteInvalidoError,
} from '../domain/seating-errors'
import { leerDistribucion } from './get-seating.use-case'
import { SEATING_REPOSITORY, type SeatingRepository } from './seating.repository'

/**
 * Sienta a una persona en un asiento:
 * - si ya estaba sentada en otro, se mueve;
 * - si el asiento tenía a alguien, se intercambian (o, si la persona no estaba
 *   sentada, el anterior queda sin asignar).
 */
@Injectable()
export class AssignSeatUseCase {
  constructor(
    @Inject(SEATING_REPOSITORY) private readonly repo: SeatingRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
  ) {}

  async ejecutar(eventId: string, destino: Asignacion): Promise<MesaVista[]> {
    return await this.unidadDeTrabajo.ejecutar(async () => {
      await this.repo.bloquearEvento(eventId)
      const mesa = await this.repo.buscarMesa(eventId, destino.tableId)
      if (mesa === null) throw new MesaNoEncontradaError()
      if (destino.seatIndex >= mesa.seatCount) throw new AsientoFueraDeRangoError()
      const invitado = await this.repo.buscarInvitado(eventId, destino.guestId)
      if (!ocupanteValido(destino, invitado)) throw new OcupanteInvalidoError()

      const asignaciones = await this.repo.listarAsignaciones(eventId)
      const origen = asignaciones.find(
        (a) => a.guestId === destino.guestId && a.companionIndex === destino.companionIndex,
      )
      const previo = asignaciones.find(
        (a) => a.tableId === destino.tableId && a.seatIndex === destino.seatIndex,
      )
      if (origen !== undefined && previo === origen)
        return await leerDistribucion(this.repo, eventId)

      await this.repo.quitarOcupantes(
        eventId,
        [origen, previo].filter((a) => a !== undefined),
      )
      await this.repo.asignar(eventId, destino)
      if (previo !== undefined && origen !== undefined) {
        await this.repo.asignar(eventId, {
          tableId: origen.tableId,
          seatIndex: origen.seatIndex,
          guestId: previo.guestId,
          companionIndex: previo.companionIndex,
        })
      }
      return await leerDistribucion(this.repo, eventId)
    })
  }
}
