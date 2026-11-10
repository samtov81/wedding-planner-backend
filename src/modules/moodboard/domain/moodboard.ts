import { UnprocessableError } from '@/shared/domain'

import { ImagenArchivadaError, TopeDeImagenesError } from './moodboard-errors'

/**
 * Tope de fotos por evento, archivadas incluidas porque nada se borra
 * (spec 2026-11-09 §5, decisión propia). Lo hace cumplir el caso de uso dentro
 * de la transacción tras bloquear la fila del evento; no hay CHECK posible.
 */
export const MAX_IMAGENES_POR_EVENTO = 500
/** Mismos límites que los CHECK `moodboard_images_titulo` y `moodboard_notes_cuerpo`. */
export const MAX_TITULO = 120
export const MAX_NOTA = 2000
/** Lado máximo en píxeles; el CHECK `moodboard_images_dimensiones` lo repite. */
export const MAX_DIMENSION = 20000

/**
 * Quien mira el tablero. Es un tipo PROPIO del módulo: el `domain/` de un
 * módulo no importa el de otro, así que no se reutiliza el acceso de events;
 * la capa de aplicación traduce `EventAccess` a esto.
 */
export type Visor = { tipo: 'miembro'; userId: string } | { tipo: 'proveedor'; userId: string }

function normalizar(valor: string, max: number, code: string, nombre: string): string {
  const limpio = valor.trim()
  if (limpio.length === 0 || limpio.length > max) {
    throw new UnprocessableError(`${nombre} debe tener entre 1 y ${max} caracteres`, code)
  }
  return limpio
}

/** `trim` y valida 1..`MAX_TITULO`; el CHECK de la base repite la regla. */
export function normalizarTitulo(valor: string): string {
  return normalizar(valor, MAX_TITULO, 'INVALID_TITLE', 'El título')
}

/** `trim` y valida 1..`MAX_NOTA`; el CHECK de la base repite la regla. */
export function normalizarNota(valor: string): string {
  return normalizar(valor, MAX_NOTA, 'INVALID_NOTE', 'La nota')
}

/** Una foto archivada no admite compartir ni notas. */
export function exigirActiva(imagen: { archivedAt: Date | null }): void {
  if (imagen.archivedAt !== null) throw new ImagenArchivadaError()
}

/** `actuales` cuenta activas y archivadas. */
export function exigirCupo(actuales: number): void {
  if (actuales >= MAX_IMAGENES_POR_EVENTO) throw new TopeDeImagenesError()
}
