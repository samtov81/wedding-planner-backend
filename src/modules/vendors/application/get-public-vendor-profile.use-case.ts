import { Inject, Injectable } from '@nestjs/common'

import { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'

import { MAX_SIMILARES } from '../domain/vendor-profile'
import { FichaNoEncontradaError } from '../domain/vendor-profile-errors'
import { aSimilar, aVista, type FichaVista, type SimilarVista } from './ficha-vista'
import {
  VENDOR_PROFILE_REPOSITORY,
  type VendorProfileRepository,
} from './vendor-profile.repository'

export interface FichaPublicaVista extends Omit<FichaVista, 'status'> {
  similar: SimilarVista[]
}

/**
 * La ficha que ve cualquiera, con o sin sesión. Sólo PUBLISHED: una apagada
 * o suspendida es el mismo 404 que una que no existe.
 */
@Injectable()
export class GetPublicVendorProfileUseCase {
  constructor(
    @Inject(VENDOR_PROFILE_REPOSITORY) private readonly fichas: VendorProfileRepository,
    private readonly imagenes: SubidaDeImagenes,
  ) {}

  async ejecutar(id: string): Promise<FichaPublicaVista> {
    const ficha = await this.fichas.buscarPublicada(id)
    if (ficha === null) throw new FichaNoEncontradaError()
    const [vista, similares] = await Promise.all([
      this.fichas.contarBodas(ficha.id).then((bodas) => aVista(ficha, this.imagenes, bodas)),
      this.fichas.similares(ficha, MAX_SIMILARES),
    ])
    const { status: _estado, ...publica } = vista
    return {
      ...publica,
      similar: await Promise.all(similares.map((s) => aSimilar(s, this.imagenes))),
    }
  }
}
