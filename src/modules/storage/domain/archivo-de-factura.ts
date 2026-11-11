import { UnprocessableError } from '@/shared/domain'

/**
 * Tipos de archivo que se aceptan como factura, con su extensión (spec
 * 2026-11-11 §7). Las imágenes son las mismas que en avatar y portfolio más el
 * PDF. Alternativa descartada: ampliar `TIPOS_DE_IMAGEN`, que habría dejado
 * subir PDF como avatar.
 */
export const TIPOS_DE_FACTURA = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
} as const

export type TipoDeFactura = keyof typeof TIPOS_DE_FACTURA

/** 10 MB por archivo de factura. */
export const MAX_BYTES_FACTURA = 10 * 1024 * 1024

export function esTipoDeFactura(valor: string): valor is TipoDeFactura {
  return Object.hasOwn(TIPOS_DE_FACTURA, valor)
}

export function archivoDeFacturaValido(contentType: string, bytes: number): boolean {
  return (
    esTipoDeFactura(contentType) &&
    Number.isInteger(bytes) &&
    bytes > 0 &&
    bytes <= MAX_BYTES_FACTURA
  )
}

export class ArchivoDeFacturaInvalidoError extends UnprocessableError {
  constructor() {
    super('La factura debe ser un PDF, JPG, PNG o WebP de hasta 10 MB', 'INVALID_INVOICE_FILE')
  }
}
