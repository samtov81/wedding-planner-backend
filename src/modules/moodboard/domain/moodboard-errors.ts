import { NotFoundError, UnprocessableError } from '@/shared/domain'

/**
 * Una foto que no existe, es de otro evento, está archivada y quien pregunta
 * es un proveedor, o no está compartida con él. Un solo error para los cuatro
 * casos a propósito: distinguirlos le diría a un proveedor qué fotos existen
 * pero no le tocan (spec 2026-11-09 §6).
 */
export class ImagenNoEncontradaError extends NotFoundError {
  constructor() {
    super('La imagen no existe', 'MOODBOARD_IMAGE_NOT_FOUND')
  }
}

/** El evento ya tiene el máximo de fotos (activas + archivadas: nada se borra). */
export class TopeDeImagenesError extends UnprocessableError {
  constructor() {
    super('El tablero ha alcanzado el máximo de imágenes', 'MOODBOARD_IMAGE_LIMIT')
  }
}

/** Una foto archivada es de sólo lectura: no se comparte ni admite notas. */
export class ImagenArchivadaError extends UnprocessableError {
  constructor() {
    super('La imagen está archivada', 'MOODBOARD_IMAGE_ARCHIVED')
  }
}

/** La categoría no existe o está desactivada. */
export class CategoriaInvalidaError extends UnprocessableError {
  constructor() {
    super('La categoría no existe o no está activa', 'MOODBOARD_INVALID_CATEGORY')
  }
}

/**
 * Alguna de las contrataciones no admite recibir la foto (de otro evento, no
 * `BOOKED` o sin ficha del marketplace). `details` lleva los ids para que la UI
 * marque cuáles; son ids de contratación del propio evento, sin datos personales.
 */
export class ProveedorNoCompartibleError extends UnprocessableError {
  constructor(eventVendorIds: string[]) {
    super(
      'Alguno de los proveedores no puede recibir la imagen',
      'MOODBOARD_VENDOR_NOT_SHAREABLE',
      { eventVendorIds },
    )
  }
}
