import { Inject, Injectable } from '@nestjs/common'

import {
  esTipoDeImagen,
  ImagenInvalidaError,
  imagenValida,
  TIPOS_DE_IMAGEN,
} from '../domain/imagen'
import { OBJECT_STORAGE, type ObjectStorage } from './object-storage.port'
import { SubidaDirecta, type SubidaPreparada } from './subida-directa'

export type { SubidaPreparada }

/**
 * Subir una foto (avatar, portfolio, moodboard): las reglas de imagen sobre
 * `SubidaDirecta`, que concentra preparar, confirmar y borrar.
 */
@Injectable()
export class SubidaDeImagenes {
  private readonly directa: SubidaDirecta

  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {
    this.directa = new SubidaDirecta(storage, {
      // eslint-disable-next-line security/detect-object-injection -- `esTipoDeImagen` ya acotó la clave
      extension: (tipo) => (esTipoDeImagen(tipo) ? TIPOS_DE_IMAGEN[tipo] : null),
      valida: imagenValida,
      errorDeTipo: () => new ImagenInvalidaError(),
    })
  }

  preparar(prefijo: string, contentType: string, bytes: number): Promise<SubidaPreparada> {
    return this.directa.preparar(prefijo, contentType, bytes)
  }

  async confirmar(prefijo: string, key: string): Promise<void> {
    await this.directa.confirmar(prefijo, key)
  }

  firmarLectura(key: string): Promise<string | null> {
    return this.storage.firmarLectura(key)
  }

  borrar(key: string): Promise<void> {
    return this.directa.borrar(key)
  }
}
