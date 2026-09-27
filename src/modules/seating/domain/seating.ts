/** Topes acordados para la distribución. Los mismos números viven en el CHECK de la migración. */
export const MAX_ASIENTOS_POR_MESA = 20
export const MAX_MESAS_POR_EVENTO = 100
/** Igual que `MAX_ACOMPANANTES` de guests; no se importa porque un dominio no mira a otro. */
export const MAX_INDICE_ACOMPANANTE = 10

export type EstadoRsvp = 'CONFIRMED' | 'PENDING' | 'DECLINED'

/** Lo único del invitado que importa para sentarlo. */
export interface InvitadoSentable {
  id: string
  rsvp: EstadoRsvp
  companionsAllowed: number
  companionsConfirmed: number | null
}

/**
 * Una mesa redonda. Sus asientos son los índices `0..seatCount-1`; `seatCount`
 * crece de `minSeats` a `maxSeats`.
 */
export interface Mesa {
  id: string
  eventId: string
  name: string
  minSeats: number
  maxSeats: number
  seatCount: number
  x: number
  y: number
  createdAt: Date
}

/** Una persona: el invitado (`companionIndex = 0`) o su acompañante n (1..10). */
export interface Ocupante {
  guestId: string
  companionIndex: number
}

export interface Asignacion extends Ocupante {
  tableId: string
  seatIndex: number
}

export interface AsientoVista {
  index: number
  occupant: (Ocupante & { sobrante: boolean }) | null
}

export interface MesaVista extends Mesa {
  seats: AsientoVista[]
}

/**
 * Cuántas personas del invitado se pueden sentar. Un DECLINED no viene. Un
 * PENDING, o un CONFIRMED que aún no dijo cuántos trae, reserva el cupo entero.
 */
export function plazasDe(invitado: InvitadoSentable): number {
  if (invitado.rsvp === 'DECLINED') return 0
  return 1 + (invitado.companionsConfirmed ?? invitado.companionsAllowed)
}

export function ocupanteValido(ocupante: Ocupante, invitado: InvitadoSentable | null): boolean {
  return invitado !== null && ocupante.companionIndex < plazasDe(invitado)
}

/**
 * Un asiento ocupado por alguien que ya no cabe en las plazas de su invitado
 * (rechazó o bajó sus acompañantes). No se libera solo: se marca y la pareja
 * decide.
 */
export function esSobrante(ocupante: Ocupante, invitado: InvitadoSentable | null): boolean {
  return !ocupanteValido(ocupante, invitado)
}

export function rangoAsientosValido(m: Pick<Mesa, 'minSeats' | 'seatCount' | 'maxSeats'>): boolean {
  return (
    m.minSeats >= 1 &&
    m.minSeats <= m.seatCount &&
    m.seatCount <= m.maxSeats &&
    m.maxSeats <= MAX_ASIENTOS_POR_MESA
  )
}

export function nombrePorDefecto(numero: number): string {
  return `Mesa ${numero}`
}

const COLUMNAS = 5
const SEPARACION = 220
const MARGEN = 40

/** Posición inicial de la mesa `i` (0-based) en una cuadrícula de cinco columnas. */
export function posicionEnCuadricula(i: number): { x: number; y: number } {
  return {
    x: MARGEN + (i % COLUMNAS) * SEPARACION,
    y: MARGEN + Math.floor(i / COLUMNAS) * SEPARACION,
  }
}

/** Arma la vista de cada mesa con sus asientos, ocupados o no. */
export function armarDistribucion(
  mesas: Mesa[],
  asignaciones: Asignacion[],
  invitados: InvitadoSentable[],
): MesaVista[] {
  const porId = new Map(invitados.map((i) => [i.id, i]))
  const porAsiento = new Map(asignaciones.map((a) => [`${a.tableId}:${a.seatIndex}`, a]))
  return mesas.map((mesa) => ({
    ...mesa,
    seats: Array.from({ length: mesa.seatCount }, (_, index) => {
      const a = porAsiento.get(`${mesa.id}:${index}`)
      if (a === undefined) return { index, occupant: null }
      const ocupante = { guestId: a.guestId, companionIndex: a.companionIndex }
      return {
        index,
        occupant: { ...ocupante, sobrante: esSobrante(ocupante, porId.get(a.guestId) ?? null) },
      }
    }),
  }))
}
