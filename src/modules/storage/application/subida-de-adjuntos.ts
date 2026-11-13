import { Inject, Injectable } from '@nestjs/common'

import { ArchivoAdjuntoInvalidoError } from '../domain/archivo-adjunto'
import {
  archivoDeFacturaValido,
  esTipoDeFactura,
  TIPOS_DE_FACTURA,
} from '../domain/archivo-de-factura'
import { OBJECT_STORAGE, type ObjectStorage } from './object-storage.port'
import { SubidaDirecta, type SubidaPreparada } from './subida-directa'

/**
 * Subir el adjunto de un mensaje directo a R2, bajo el prefijo
 * `events/<eventId>/messages/<conversationId>` que pone el caso de uso (spec
 * 2026-11-12 §7). Admite lo mismo que una factura (PDF, JPG, PNG, WebP, hasta
 * 10 MB) y reutiliza sus reglas, pero con su propio error.
 *
 * Alternativa descartada: reutilizar `SubidaDeFacturas`. Habría hecho que un
 * adjunto rechazado respondiera `INVALID_INVOICE_FILE`, un código que habla de
 * facturas, y habría acoplado dos ciclos de vida distintos (el del mensaje y el
 * de la factura) a una misma clase. Ambas envuelven `SubidaDirecta`, así que
 * la comprobación de prefijo y el borrado del objeto no válido no divergen.
 */
@Injectable()
export class SubidaDeAdjuntos {
  private readonly directa: SubidaDirecta

  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {
    this.directa = new SubidaDirecta(storage, {
      // eslint-disable-next-line security/detect-object-injection -- `esTipoDeFactura` ya acotó la clave
      extension: (tipo) => (esTipoDeFactura(tipo) ? TIPOS_DE_FACTURA[tipo] : null),
      valida: archivoDeFacturaValido,
      errorDeTipo: () => new ArchivoAdjuntoInvalidoError(),
    })
  }

  preparar(prefijo: string, contentType: string, bytes: number): Promise<SubidaPreparada> {
    return this.directa.preparar(prefijo, contentType, bytes)
  }

  confirmar(prefijo: string, key: string): Promise<{ contentType: string; bytes: number }> {
    return this.directa.confirmar(prefijo, key)
  }

  /** URL de descarga de vida corta con el nombre original, o `null` sin almacén. */
  firmarLectura(key: string, nombre: string): Promise<string | null> {
    return this.storage.firmarLectura(key, nombre)
  }
}
