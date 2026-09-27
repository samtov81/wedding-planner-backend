import { Inject, Injectable } from '@nestjs/common'

import { armarDistribucion, type MesaVista } from '../domain/seating'
import { SEATING_REPOSITORY, type SeatingRepository } from './seating.repository'

/** La distribución entera del evento. La reusan los casos de uso que responden con ella. */
export async function leerDistribucion(
  repo: SeatingRepository,
  eventId: string,
): Promise<MesaVista[]> {
  const [mesas, asignaciones, invitados] = await Promise.all([
    repo.listarMesas(eventId),
    repo.listarAsignaciones(eventId),
    repo.listarInvitados(eventId),
  ])
  return armarDistribucion(mesas, asignaciones, invitados)
}

@Injectable()
export class GetSeatingUseCase {
  constructor(@Inject(SEATING_REPOSITORY) private readonly repo: SeatingRepository) {}

  async ejecutar(eventId: string): Promise<MesaVista[]> {
    return await leerDistribucion(this.repo, eventId)
  }
}
