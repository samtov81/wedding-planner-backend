import { Inject, Injectable } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'

import { MAX_OBJETOS_POR_EVENTO, type ObjetoDeSala } from '../domain/seating'
import { LimiteDeObjetosError } from '../domain/seating-errors'
import {
  type DatosNuevoObjeto,
  SEATING_REPOSITORY,
  type SeatingRepository,
} from './seating.repository'

@Injectable()
export class CreateObjectUseCase {
  constructor(
    @Inject(SEATING_REPOSITORY) private readonly repo: SeatingRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
  ) {}

  /**
   * El tope de 30 se comprueba con el evento bloqueado: sin el bloqueo, dos
   * altas concurrentes verían 29 y las dos pasarían. Es una regla de este caso
   * de uso, no de la base de datos (un CHECK no puede contar filas).
   */
  async ejecutar(eventId: string, datos: DatosNuevoObjeto): Promise<ObjetoDeSala> {
    return await this.unidadDeTrabajo.ejecutar(async () => {
      await this.repo.bloquearEvento(eventId)
      if ((await this.repo.contarObjetos(eventId)) >= MAX_OBJETOS_POR_EVENTO) {
        throw new LimiteDeObjetosError()
      }
      return await this.repo.crearObjeto(eventId, datos)
    })
  }
}
