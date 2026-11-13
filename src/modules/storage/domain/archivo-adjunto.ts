import { UnprocessableError } from '@/shared/domain'

/**
 * Error de un adjunto de mensajería con tipo o tamaño no admitidos. Las reglas
 * son las de factura (`TIPOS_DE_FACTURA`, `archivoDeFacturaValido`); sólo
 * cambia el código, para que el cliente distinga un adjunto de una factura.
 */
export class ArchivoAdjuntoInvalidoError extends UnprocessableError {
  constructor() {
    super('El adjunto debe ser un PDF, JPG, PNG o WebP de hasta 10 MB', 'INVALID_ATTACHMENT')
  }
}
