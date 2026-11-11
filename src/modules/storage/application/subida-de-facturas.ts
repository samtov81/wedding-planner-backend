import { Inject, Injectable } from '@nestjs/common'

import {
  archivoDeFacturaValido,
  ArchivoDeFacturaInvalidoError,
  esTipoDeFactura,
  TIPOS_DE_FACTURA,
} from '../domain/archivo-de-factura'
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

  borrar(key: string): Promise<void> {
    return this.directa.borrar(key)
  }
}
