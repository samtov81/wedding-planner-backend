import { Inject, Injectable } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'

import {
  type DatosDeFicha,
  estadoAlCambiarModo,
  type FichaDeProveedor,
} from '../domain/vendor-profile'
import { FichaNoEncontradaError, FichaSuspendidaError } from '../domain/vendor-profile-errors'
import { aVista, type FichaVista } from './ficha-vista'
import {
  type NuevoPaquete,
  VENDOR_PROFILE_REPOSITORY,
  type VendorProfileRepository,
} from './vendor-profile.repository'

/** La ficha del usuario con sesión, o 404 si nunca la creó. */
@Injectable()
export class GetMyVendorProfileUseCase {
  constructor(
    @Inject(VENDOR_PROFILE_REPOSITORY) private readonly fichas: VendorProfileRepository,
    private readonly imagenes: SubidaDeImagenes,
  ) {}

  async ejecutar(userId: string): Promise<FichaVista> {
    return await this.vista(await this.exigir(userId))
  }

  async exigir(userId: string): Promise<FichaDeProveedor> {
    const ficha = await this.fichas.buscarPorUsuario(userId)
    if (ficha === null) throw new FichaNoEncontradaError()
    return ficha
  }

  async vista(ficha: FichaDeProveedor): Promise<FichaVista> {
    return await aVista(ficha, this.imagenes, await this.fichas.contarBodas(ficha.id))
  }
}

/** Alta (en DRAFT: el switch es otro paso) o edición de los datos de la ficha. */
@Injectable()
export class SaveMyVendorProfileUseCase {
  constructor(
    @Inject(VENDOR_PROFILE_REPOSITORY) private readonly fichas: VendorProfileRepository,
    private readonly leer: GetMyVendorProfileUseCase,
  ) {}

  async ejecutar(userId: string, datos: DatosDeFicha): Promise<FichaVista> {
    return await this.leer.vista(await this.fichas.guardarDatos(userId, datos))
  }
}

/** El switch "soy proveedor": encendido = PUBLISHED, apagado = DRAFT. */
@Injectable()
export class SetVendorModeUseCase {
  constructor(
    @Inject(VENDOR_PROFILE_REPOSITORY) private readonly fichas: VendorProfileRepository,
    private readonly leer: GetMyVendorProfileUseCase,
  ) {}

  async ejecutar(userId: string, activo: boolean): Promise<FichaVista> {
    const ficha = await this.leer.exigir(userId)
    const estado = estadoAlCambiarModo(ficha.status, activo)
    if (estado === null) throw new FichaSuspendidaError()
    await this.fichas.fijarEstado(ficha.id, estado)
    return await this.leer.vista({ ...ficha, status: estado })
  }
}

@Injectable()
export class ReplacePackagesUseCase {
  constructor(
    @Inject(VENDOR_PROFILE_REPOSITORY) private readonly fichas: VendorProfileRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    private readonly leer: GetMyVendorProfileUseCase,
  ) {}

  async ejecutar(userId: string, paquetes: NuevoPaquete[]): Promise<FichaVista> {
    const ficha = await this.leer.exigir(userId)
    await this.unidadDeTrabajo.ejecutar(() => this.fichas.reemplazarPaquetes(ficha.id, paquetes))
    return await this.leer.ejecutar(userId)
  }
}
