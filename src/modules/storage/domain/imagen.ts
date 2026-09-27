import { DomainError, UnprocessableError } from '@/shared/domain'

/** Tipos de imagen que se aceptan para avatar y portfolio, con su extensión. */
export const TIPOS_DE_IMAGEN = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

export type TipoDeImagen = keyof typeof TIPOS_DE_IMAGEN

/** 10 MB por foto. */
export const MAX_BYTES_IMAGEN = 10 * 1024 * 1024

export function esTipoDeImagen(valor: string): valor is TipoDeImagen {
  return Object.hasOwn(TIPOS_DE_IMAGEN, valor)
}

export function imagenValida(contentType: string, bytes: number): boolean {
  return (
    esTipoDeImagen(contentType) && Number.isInteger(bytes) && bytes > 0 && bytes <= MAX_BYTES_IMAGEN
  )
}

export class ImagenInvalidaError extends UnprocessableError {
  constructor() {
    super('La imagen debe ser JPG, PNG o WebP de hasta 10 MB', 'INVALID_IMAGE')
  }
}

/**
 * La key confirmada no es una subida válida de ESTE usuario: no existe, no es
 * suya o lo que se subió no respeta tipo y tamaño. Mismo error en los tres
 * casos: no se revela si una key ajena existe.
 */
export class SubidaNoValidaError extends UnprocessableError {
  constructor() {
    super('No hay una subida válida con esa key', 'INVALID_UPLOAD')
  }
}

/** Sin R2 configurado. No es culpa del cliente: 503, no 4xx. */
export class AlmacenamientoNoDisponibleError extends DomainError {
  readonly httpStatus = 503
  constructor() {
    super('El almacenamiento de archivos no está disponible', 'STORAGE_UNAVAILABLE')
  }
}
