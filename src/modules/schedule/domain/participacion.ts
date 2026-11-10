import { UnprocessableError } from '@/shared/domain'
import type { ScheduleItemStatus } from './schedule-item'

/** Cuánto antes de `startsAt` llega el recordatorio: 15 minutos (spec 2026-11-10 §5). */
export const ANTELACION_RECORDATORIO_MS = 900_000

/** Tope de una nota del planner, el mismo que el CHECK `schedule_item_notes_cuerpo`. */
export const MAX_NOTA = 2000

/**
 * `trim` y valida 1..`MAX_NOTA`. El CHECK de la base repite la regla: esta
 * función existe para devolver un 422 con código en vez de un 500 de Postgres.
 */
export function normalizarNota(valor: string): string {
  const limpio = valor.trim()
  if (limpio.length === 0 || limpio.length > MAX_NOTA) {
    throw new UnprocessableError(
      `La nota debe tener entre 1 y ${MAX_NOTA} caracteres`,
      'INVALID_NOTE',
    )
  }
  return limpio
}

function mismoInstante(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b
  return a.getTime() === b.getTime()
}

/**
 * ¿Los cambios tocan la hora? `startsAt` y `endsAt` cuentan por igual (spec
 * 2026-11-10 §4); título, descripción, lugar y estado no pasan por aquí.
 * Compara instantes y no referencias: dos `Date` iguales no son un cambio, y
 * desconfirmar por un PATCH que repite la hora castigaría al proveedor sin
 * motivo. `undefined` = el campo no viene en el PATCH; `null` en `endsAt` =
 * quitar la hora de fin, que sí es un cambio.
 */
export function cambiaLaHora(
  antes: { startsAt: Date; endsAt: Date | null },
  cambios: { startsAt?: Date | undefined; endsAt?: Date | null | undefined },
): boolean {
  if (cambios.startsAt !== undefined && !mismoInstante(cambios.startsAt, antes.startsAt)) {
    return true
  }
  return cambios.endsAt !== undefined && !mismoInstante(cambios.endsAt, antes.endsAt)
}

/** Cuándo debe dispararse el recordatorio de un ítem que empieza en `startsAt`. */
export function momentoDelRecordatorio(startsAt: Date): Date {
  return new Date(startsAt.getTime() - ANTELACION_RECORDATORIO_MS)
}

/**
 * ¿Merece la pena encolar el recordatorio? Sólo si su momento está en el
 * futuro: con 15 minutos justos o menos, el aviso ya no sería "antes".
 */
export function debeProgramarse(startsAt: Date, ahora: Date): boolean {
  return momentoDelRecordatorio(startsAt).getTime() > ahora.getTime()
}

/**
 * Decide, al procesar el job, si el aviso sigue siendo cierto. El job lleva
 * el `startsAt` con el que se encoló y NUNCA se borra (spec 2026-11-10 §5):
 * si el ítem cambió de hora, el job viejo se descarta aquí por no coincidir
 * y el nuevo es el que avisa. Alternativa descartada: borrar jobs al
 * reprogramar, que con A→B→A deja cero o dos recordatorios según la carrera.
 */
export function debeAvisar(
  estado: { status: ScheduleItemStatus; startsAt: Date },
  startsAtDelJob: Date,
  ahora: Date,
): boolean {
  return (
    estado.status === 'PENDING' &&
    mismoInstante(estado.startsAt, startsAtDelJob) &&
    ahora.getTime() <= estado.startsAt.getTime()
  )
}
