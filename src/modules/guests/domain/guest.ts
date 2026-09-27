/**
 * Estados de asistencia. Se declara aquí, en `domain/`, y NO se importa el
 * enum de `@prisma/client`: el dominio no conoce Prisma (regla de dependencia)
 * y, además, un enum del ORM ataría el vocabulario del negocio a la forma de
 * persistirlo. El compilador sigue atando los dos: la fila de Prisma se asigna
 * a este tipo en el adaptador, así que añadir un estado en el esquema sin
 * añadirlo aquí no compila.
 */
export type RsvpStatus = 'CONFIRMED' | 'PENDING' | 'DECLINED'

export const RSVP_STATUSES = [
  'CONFIRMED',
  'PENDING',
  'DECLINED',
] as const satisfies readonly RsvpStatus[]

/**
 * Un invitado del evento. `email` es opcional a propósito —se invita también
 * por teléfono, en persona o por carta— y lo que eso arrastra vive en el
 * envío (Tarea 12): sin email no hay invitación, y eso se dice en voz alta,
 * no se silencia.
 */
export interface Guest {
  id: string
  eventId: string
  name: string
  email: string | null
  group: string
  rsvp: RsvpStatus
  dietary: string | null
  /** Cuántos acompañantes puede traer. Lo decide quien organiza, 0..`MAX_ACOMPANANTES`. */
  companionsAllowed: number
  /**
   * Cuántos trae de verdad, dicho por el invitado al responder. `null` = aún no
   * respondió; un DECLINED trae 0. Nunca supera `companionsAllowed` (CHECK en SQL).
   */
  companionsConfirmed: number | null
  createdAt: Date
}

/** Tope por invitado. El mismo número vive en el CHECK de la migración. */
export const MAX_ACOMPANANTES = 10

export interface GuestSummary {
  total: number
  confirmed: number
  pending: number
  declined: number
  /** Personas que asisten: invitados confirmados más sus acompañantes confirmados. */
  attending: number
}

/**
 * El resumen se DERIVA de los conteos por estado; no existe ninguna columna
 * de contador. Una columna se desincroniza en cuanto alguien actualiza un
 * RSVP por una vía que no la mantiene, y entonces el total miente sin que
 * nada falle. Aquí `total` no puede discrepar de la suma porque es la suma.
 */
export function resumirPorEstado(
  conteo: Record<RsvpStatus, number>,
  acompanantesConfirmados: number,
): GuestSummary {
  return {
    total: conteo.CONFIRMED + conteo.PENDING + conteo.DECLINED,
    confirmed: conteo.CONFIRMED,
    pending: conteo.PENDING,
    declined: conteo.DECLINED,
    attending: conteo.CONFIRMED + acompanantesConfirmados,
  }
}

/**
 * ¿Se puede fijar `permitidos` sin dejar a nadie fuera? Bajar el cupo por
 * debajo de lo que el invitado ya confirmó mentiría a la pareja sobre cuántos
 * vienen; se rechaza y que lo hablen con el invitado.
 */
export function cupoCubreConfirmados(permitidos: number, confirmados: number | null): boolean {
  return confirmados === null || confirmados <= permitidos
}
