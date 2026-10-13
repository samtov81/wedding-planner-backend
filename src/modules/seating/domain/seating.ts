/** Topes acordados para la distribución. Los mismos números viven en el CHECK de la migración. */
export const MAX_ASIENTOS_POR_MESA = 20
export const MAX_MESAS_POR_EVENTO = 100
/** Tope de objetos de sala por evento. Lo aplica el caso de uso, no la base de datos. */
export const MAX_OBJETOS_POR_EVENTO = 30
/** Largo máximo de la etiqueta de un objeto; el mismo número vive en el CHECK de la migración. */
export const MAX_ETIQUETA = 60
/** Igual que `MAX_ACOMPANANTES` de guests; no se importa porque un dominio no mira a otro. */
export const MAX_INDICE_ACOMPANANTE = 10

/** Forma de dibujo de una mesa. Existentes en la base antes de esto: todas ROUND. */
export const FORMAS_MESA = ['ROUND', 'RECTANGULAR'] as const
export type FormaMesa = (typeof FORMAS_MESA)[number]

/** Qué es un objeto de sala. Fijo tras crearlo: cambiar de tipo es borrar y crear otro. */
export const TIPOS_OBJETO = ['DANCE_FLOOR', 'STAGE', 'BAR', 'DESSERT_TABLE', 'ENTRANCE'] as const
export type TipoObjeto = (typeof TIPOS_OBJETO)[number]

export type EstadoRsvp = 'CONFIRMED' | 'PENDING' | 'DECLINED'

/** Lo único del invitado que importa para sentarlo. */
export interface InvitadoSentable {
  id: string
  rsvp: EstadoRsvp
  companionsAllowed: number
  companionsConfirmed: number | null
}

/**
 * Una mesa redonda o rectangular; la forma sólo cambia el dibujo, los asientos
 * siguen siendo `0..seatCount-1`; `seatCount` crece de `minSeats` a `maxSeats`.
 *
 * El rango de asientos (`rangoAsientosValido`) es el mismo para las dos formas.
 * Cómo se reparten los asientos por los lados de una mesa rectangular es
 * dibujo y vive sólo en el frontend: no se añade aquí ninguna regla por forma.
 * Cambiar la forma de una mesa conserva sus asignaciones, porque los índices
 * de asiento no dependen de ella.
 */
export interface Mesa {
  id: string
  eventId: string
  name: string
  shape: FormaMesa
  minSeats: number
  maxSeats: number
  seatCount: number
  x: number
  y: number
  createdAt: Date
}

/**
 * Un objeto de la sala (pista de baile, escenario, barra...). No tiene
 * asientos, tamaño ni rotación: sólo un tipo, una etiqueta y una posición en
 * el lienzo. El tope de `MAX_OBJETOS_POR_EVENTO` lo aplica el caso de uso.
 */
export interface ObjetoDeSala {
  id: string
  eventId: string
  kind: TipoObjeto
  label: string
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
