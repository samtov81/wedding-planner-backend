import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'

import type { DomainError } from '@/shared/domain'

import { AlmacenamientoNoDisponibleError, SubidaNoValidaError } from '../domain/imagen'
import type { ObjectStorage, ObjetoAlmacenado } from './object-storage.port'

export interface SubidaPreparada {
  key: string
  uploadUrl: string
}

/** Lo que distingue una subida de otra: qué tipos admite y con qué error se rechaza. */
export interface ReglasDeSubida {
  /** Extensión de la key para ese tipo, o `null` si el tipo no se admite. */
  extension(contentType: string): string | null
  valida(contentType: string, bytes: number): boolean
  errorDeTipo: () => DomainError
}

/**
 * Las mitades de subir un archivo directo a R2, sin decorador y parametrizadas
 * por reglas: `SubidaDeImagenes` y `SubidaDeFacturas` la envuelven (spec
 * 2026-11-11 §7). Alternativa descartada: copiar `SubidaDeImagenes` para las
 * facturas, que habría duplicado la comprobación de prefijo y el borrado del
 * objeto no válido, justo lo que no debe divergir.
 *
 *  1. `preparar`: valida tipo y tamaño declarados, inventa la key bajo el
 *     prefijo del dueño y firma un PUT atado a ese tipo y tamaño.
 *  2. `confirmar`: el cliente ya subió; se comprueba en R2 que la key es de
 *     ese prefijo y que lo subido respeta las reglas. Lo que el cliente diga
 *     sobre el archivo no cuenta: cuenta lo que hay en el bucket.
 */
export class SubidaDirecta {
  private readonly logger = new Logger(SubidaDirecta.name)

  constructor(
    private readonly storage: ObjectStorage,
    private readonly reglas: ReglasDeSubida,
  ) {}

  async preparar(prefijo: string, contentType: string, bytes: number): Promise<SubidaPreparada> {
    if (!this.storage.disponible) throw new AlmacenamientoNoDisponibleError()
    const extension = this.reglas.extension(contentType)
    if (extension === null || !this.reglas.valida(contentType, bytes)) {
      throw this.reglas.errorDeTipo()
    }
    const key = `${prefijo}/${randomUUID()}.${extension}`
    return { key, uploadUrl: await this.storage.firmarSubida(key, contentType, bytes) }
  }

  /** Devuelve lo que hay en el bucket, ya validado. */
  async confirmar(prefijo: string, key: string): Promise<{ contentType: string; bytes: number }> {
    if (!this.storage.disponible) throw new AlmacenamientoNoDisponibleError()
    if (!key.startsWith(`${prefijo}/`) || key.includes('..')) throw new SubidaNoValidaError()
    const objeto: ObjetoAlmacenado | null = await this.storage.inspeccionar(key)
    if (objeto === null) throw new SubidaNoValidaError()
    if (objeto.contentType === null || !this.reglas.valida(objeto.contentType, objeto.bytes)) {
      await this.borrar(key)
      throw new SubidaNoValidaError()
    }
    return { contentType: objeto.contentType, bytes: objeto.bytes }
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
