import type { Asignacion, InvitadoSentable, Mesa, Ocupante } from '../domain/seating'

export interface DatosNuevaMesa {
  name: string
  minSeats: number
  maxSeats: number
  seatCount: number
  x: number
  y: number
}

export interface CambiosMesa {
  name?: string | undefined
  minSeats?: number | undefined
  maxSeats?: number | undefined
  seatCount?: number | undefined
  x?: number | undefined
  y?: number | undefined
}

/**
 * Todo scoped por `eventId`: una mesa o asignación de otro evento no existe.
 *
 * Las reglas que cruzan filas (el asiento existe, la persona cabe, el tope de
 * mesas) se comprueban en el caso de uso tras `bloquearEvento`, dentro de una
 * unidad de trabajo: así dos escrituras concurrentes sobre la distribución del
 * mismo evento no pueden validar contra un estado que la otra está cambiando.
 */
export interface SeatingRepository {
  /** Serializa las escrituras de distribución del evento hasta el fin de la transacción. */
  bloquearEvento(eventId: string): Promise<void>

  /** Orden de creación (createdAt, id). */
  listarMesas(eventId: string): Promise<Mesa[]>
  buscarMesa(eventId: string, tableId: string): Promise<Mesa | null>
  contarMesas(eventId: string): Promise<number>
  /** Las crea en el orden dado; ese es también el orden en que se listan. */
  crearMesas(eventId: string, datos: DatosNuevaMesa[]): Promise<Mesa[]>
  /** Lanza `MesaNoEncontradaError` si no existe en el evento. */
  actualizarMesa(eventId: string, tableId: string, cambios: CambiosMesa): Promise<Mesa>
  /** Borra la mesa y sus asignaciones. `false` si no existía. */
  eliminarMesa(eventId: string, tableId: string): Promise<boolean>

  listarAsignaciones(eventId: string): Promise<Asignacion[]>
  asignar(eventId: string, asignacion: Asignacion): Promise<void>
  quitarOcupantes(eventId: string, ocupantes: Ocupante[]): Promise<void>
  quitarAsiento(eventId: string, tableId: string, seatIndex: number): Promise<void>

  /** `null` si no existe o es de otro evento. */
  buscarInvitado(eventId: string, guestId: string): Promise<InvitadoSentable | null>
  listarInvitados(eventId: string): Promise<InvitadoSentable[]>
}

export const SEATING_REPOSITORY = Symbol('SEATING_REPOSITORY')
