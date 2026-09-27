import { Inject, Injectable } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import {
  SubidaDeImagenes,
  type SubidaPreparada,
} from '@/modules/storage/application/subida-de-imagenes'

import { MAX_FOTOS_PORTFOLIO, prefijoDePortfolio } from '../domain/vendor-profile'
import {
  FotoNoEncontradaError,
  LimiteDeFotosError,
  OrdenDeFotosInvalidoError,
} from '../domain/vendor-profile-errors'
import type { FichaVista } from './ficha-vista'
import { GetMyVendorProfileUseCase } from './my-vendor-profile.use-cases'
import {
  VENDOR_PROFILE_REPOSITORY,
  type VendorProfileRepository,
} from './vendor-profile.repository'

/**
 * Paso 1 de añadir una foto: firma el PUT. Se rechaza ya aquí si el
 * portfolio está lleno, para no dejar subir algo que no se podrá guardar
 * (el límite se vuelve a comprobar, con la ficha bloqueada, al confirmar).
 */
@Injectable()
export class PreparePortfolioUploadUseCase {
  constructor(
    private readonly leer: GetMyVendorProfileUseCase,
    private readonly imagenes: SubidaDeImagenes,
  ) {}

  async ejecutar(
    userId: string,
    archivo: { contentType: string; size: number },
  ): Promise<SubidaPreparada> {
    const ficha = await this.leer.exigir(userId)
    if (ficha.portfolio.length >= MAX_FOTOS_PORTFOLIO) throw new LimiteDeFotosError()
    return await this.imagenes.preparar(
      prefijoDePortfolio(userId),
      archivo.contentType,
      archivo.size,
    )
  }
}

/** Paso 2: comprueba lo subido y lo añade al final del portfolio. */
@Injectable()
export class AddPortfolioImageUseCase {
  constructor(
    @Inject(VENDOR_PROFILE_REPOSITORY) private readonly fichas: VendorProfileRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    private readonly imagenes: SubidaDeImagenes,
    private readonly leer: GetMyVendorProfileUseCase,
  ) {}

  async ejecutar(userId: string, foto: { key: string; alt: string }): Promise<FichaVista> {
    const ficha = await this.leer.exigir(userId)
    await this.imagenes.confirmar(prefijoDePortfolio(userId), foto.key)
    try {
      await this.unidadDeTrabajo.ejecutar(async () => {
        await this.fichas.bloquearFicha(ficha.id)
        const actual = await this.fichas.buscarPorUsuario(userId)
        if ((actual?.portfolio.length ?? 0) >= MAX_FOTOS_PORTFOLIO) throw new LimiteDeFotosError()
        await this.fichas.agregarFoto(ficha.id, { storageKey: foto.key, alt: foto.alt })
      })
    } catch (error) {
      // Lo subido no llegó a guardarse: que no quede huérfano en R2.
      if (error instanceof LimiteDeFotosError) await this.imagenes.borrar(foto.key)
      throw error
    }
    return await this.leer.ejecutar(userId)
  }
}

@Injectable()
export class UpdatePortfolioImageUseCase {
  constructor(
    @Inject(VENDOR_PROFILE_REPOSITORY) private readonly fichas: VendorProfileRepository,
    private readonly leer: GetMyVendorProfileUseCase,
  ) {}

  async ejecutar(userId: string, fotoId: string, cambios: { alt: string }): Promise<FichaVista> {
    const ficha = await this.leer.exigir(userId)
    if (!(await this.fichas.cambiarAlt(ficha.id, fotoId, cambios.alt))) {
      throw new FotoNoEncontradaError()
    }
    return await this.leer.ejecutar(userId)
  }
}

@Injectable()
export class RemovePortfolioImageUseCase {
  constructor(
    @Inject(VENDOR_PROFILE_REPOSITORY) private readonly fichas: VendorProfileRepository,
    private readonly imagenes: SubidaDeImagenes,
    private readonly leer: GetMyVendorProfileUseCase,
  ) {}

  async ejecutar(userId: string, fotoId: string): Promise<void> {
    const ficha = await this.leer.exigir(userId)
    const key = await this.fichas.borrarFoto(ficha.id, fotoId)
    if (key === null) throw new FotoNoEncontradaError()
    await this.imagenes.borrar(key)
  }
}

@Injectable()
export class ReorderPortfolioUseCase {
  constructor(
    @Inject(VENDOR_PROFILE_REPOSITORY) private readonly fichas: VendorProfileRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    private readonly leer: GetMyVendorProfileUseCase,
  ) {}

  async ejecutar(userId: string, ids: string[]): Promise<FichaVista> {
    const ficha = await this.leer.exigir(userId)
    await this.unidadDeTrabajo.ejecutar(async () => {
      await this.fichas.bloquearFicha(ficha.id)
      const actuales =
        (await this.fichas.buscarPorUsuario(userId))?.portfolio.map((f) => f.id) ?? []
      const pedidas = new Set(ids)
      if (
        pedidas.size !== ids.length ||
        pedidas.size !== actuales.length ||
        !actuales.every((id) => pedidas.has(id))
      ) {
        throw new OrdenDeFotosInvalidoError()
      }
      await this.fichas.reordenarFotos(ficha.id, ids)
    })
    return await this.leer.ejecutar(userId)
  }
}
