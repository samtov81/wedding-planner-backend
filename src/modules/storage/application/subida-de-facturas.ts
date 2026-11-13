import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'

import {
  archivoDeFacturaValido,
  ArchivoDeFacturaInvalidoError,
  esTipoDeFactura,
  TIPOS_DE_FACTURA,
} from '../domain/archivo-de-factura'
import { AlmacenamientoNoDisponibleError } from '../domain/imagen'
import { OBJECT_STORAGE, type ObjectStorage } from './object-storage.port'
import { SubidaDirecta, type SubidaPreparada } from './subida-directa'

/**
 * Subir el archivo de una factura (PDF o imagen) directo a R2, bajo el prefijo
 * `events/<eventId>/invoices` que pone el caso de uso (spec 2026-11-11 §7).
 * `firmarLectura` pide descarga con el nombre original del archivo.
 */
@Injectable()
export class SubidaDeFacturas {
  private readonly directa: SubidaDirecta

  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {
    this.directa = new SubidaDirecta(storage, {
      // eslint-disable-next-line security/detect-object-injection -- `esTipoDeFactura` ya acotó la clave
      extension: (tipo) => (esTipoDeFactura(tipo) ? TIPOS_DE_FACTURA[tipo] : null),
      valida: archivoDeFacturaValido,
      errorDeTipo: () => new ArchivoDeFacturaInvalidoError(),
    })
  }

  preparar(prefijo: string, contentType: string, bytes: number): Promise<SubidaPreparada> {
    return this.directa.preparar(prefijo, contentType, bytes)
  }

  confirmar(prefijo: string, key: string): Promise<{ contentType: string; bytes: number }> {
    return this.directa.confirmar(prefijo, key)
  }

  firmarLectura(key: string, nombre: string): Promise<string | null> {
    return this.storage.firmarLectura(key, nombre)
  }

  /**
   * Copia un objeto ya guardado (p. ej. el adjunto de un mensaje) a una key
   * nueva bajo `prefijo`, para que la factura tenga su propio archivo y borrar
   * el mensaje o la factura no toque al otro. El tipo lo dice el llamante (lo
   * guardado en la fila del adjunto) y debe ser de factura.
   */
  async copiarDesde(origen: string, prefijo: string, contentType: string): Promise<string> {
    if (!this.storage.disponible) throw new AlmacenamientoNoDisponibleError()
    if (!esTipoDeFactura(contentType)) throw new ArchivoDeFacturaInvalidoError()
    // eslint-disable-next-line security/detect-object-injection -- `esTipoDeFactura` ya acotó la clave
    const destino = `${prefijo}/${randomUUID()}.${TIPOS_DE_FACTURA[contentType]}`
    await this.storage.copiar(origen, destino)
    return destino
  }

  borrar(key: string): Promise<void> {
    return this.directa.borrar(key)
  }
}
