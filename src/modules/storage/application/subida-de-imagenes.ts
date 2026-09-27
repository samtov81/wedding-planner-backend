import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  AlmacenamientoNoDisponibleError,
  esTipoDeImagen,
  ImagenInvalidaError,
  imagenValida,
  SubidaNoValidaError,
  TIPOS_DE_IMAGEN,
} from '../domain/imagen'
import { OBJECT_STORAGE, type ObjectStorage } from './object-storage.port'

export interface SubidaPreparada {
  key: string
  uploadUrl: string
}

/**
 * Las dos mitades de subir una foto, compartidas por avatar y portfolio:
 *  1. `preparar`: valida tipo y tamaño declarados, inventa la key bajo el
 *     prefijo del dueño y firma un PUT atado a ese tipo y tamaño.
 *  2. `confirmar`: el cliente ya subió; se comprueba en R2 que la key es de
 *     ese prefijo y que lo subido respeta las reglas. Lo que el cliente diga
 *     sobre el archivo no cuenta: cuenta lo que hay en el bucket.
 */
@Injectable()
export class SubidaDeImagenes {
  private readonly logger = new Logger(SubidaDeImagenes.name)

  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  async preparar(prefijo: string, contentType: string, bytes: number): Promise<SubidaPreparada> {
    if (!this.storage.disponible) throw new AlmacenamientoNoDisponibleError()
    if (!esTipoDeImagen(contentType) || !imagenValida(contentType, bytes)) {
      throw new ImagenInvalidaError()
    }
    // eslint-disable-next-line security/detect-object-injection -- `esTipoDeImagen` ya acotó la clave
    const key = `${prefijo}/${randomUUID()}.${TIPOS_DE_IMAGEN[contentType]}`
    return { key, uploadUrl: await this.storage.firmarSubida(key, contentType, bytes) }
  }

  async confirmar(prefijo: string, key: string): Promise<void> {
    if (!this.storage.disponible) throw new AlmacenamientoNoDisponibleError()
    if (!key.startsWith(`${prefijo}/`) || key.includes('..')) throw new SubidaNoValidaError()
    const objeto = await this.storage.inspeccionar(key)
    if (objeto === null) throw new SubidaNoValidaError()
    if (objeto.contentType === null || !imagenValida(objeto.contentType, objeto.bytes)) {
      await this.borrar(key)
      throw new SubidaNoValidaError()
    }
  }

  firmarLectura(key: string): Promise<string | null> {
    return this.storage.firmarLectura(key)
  }

  /**
   * Borrar un objeto que ya no se usa no debe tumbar la operación que lo
   * reemplazó (la fila ya se guardó): se registra y se sigue.
   */
  async borrar(key: string): Promise<void> {
    if (!this.storage.disponible) return
    try {
      await this.storage.borrar(key)
    } catch (error) {
      this.logger.warn(`No se pudo borrar de R2 la key ${key}: ${String(error)}`)
    }
  }
}
