import { randomUUID } from 'node:crypto'

import type {
  CambiosMesa,
  DatosNuevaMesa,
  SeatingRepository,
} from '../application/seating.repository'
import type { Asignacion, InvitadoSentable, Mesa, Ocupante } from '../domain/seating'
import { MesaNoEncontradaError } from '../domain/seating-errors'

type AsignacionGuardada = Asignacion & { eventId: string }
type InvitadoGuardado = InvitadoSentable & { eventId: string }

/**
 * Doble en memoria. `bloquearEvento` no hace nada: aquí no hay concurrencia
 * real. Las restricciones únicas de la base (un ocupante por asiento, un
 * asiento por persona) se imitan para que un caso de uso que las viole falle
 * igual que contra Postgres.
 */
export class SeatingRepositoryEnMemoria implements SeatingRepository {
  readonly mesas: Mesa[] = []
  readonly asignaciones: AsignacionGuardada[] = []
  readonly invitados: InvitadoGuardado[] = []

  sembrarInvitado(eventId: string, invitado: InvitadoSentable): void {
    this.invitados.push({ ...invitado, eventId })
  }

  bloquearEvento(): Promise<void> {
    return Promise.resolve()
  }

  listarMesas(eventId: string): Promise<Mesa[]> {
    return Promise.resolve(
      this.mesas
        .filter((m) => m.eventId === eventId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
        .map((m) => ({ ...m })),
    )
  }

  buscarMesa(eventId: string, tableId: string): Promise<Mesa | null> {
    const mesa = this.mesas.find((m) => m.id === tableId && m.eventId === eventId)
    return Promise.resolve(mesa === undefined ? null : { ...mesa })
  }

  contarMesas(eventId: string): Promise<number> {
    return Promise.resolve(this.mesas.filter((m) => m.eventId === eventId).length)
  }

  crearMesas(eventId: string, datos: DatosNuevaMesa[]): Promise<Mesa[]> {
    const ultima = Math.max(
      0,
      ...this.mesas.filter((m) => m.eventId === eventId).map((m) => m.createdAt.getTime()),
    )
    const base = Math.max(Date.now(), ultima + 1)
    const creadas = datos.map((d, i) => ({
      ...d,
      id: randomUUID(),
      eventId,
      createdAt: new Date(base + i),
    }))
    this.mesas.push(...creadas)
    return Promise.resolve(creadas.map((m) => ({ ...m })))
  }

  actualizarMesa(eventId: string, tableId: string, cambios: CambiosMesa): Promise<Mesa> {
    const mesa = this.mesas.find((m) => m.id === tableId && m.eventId === eventId)
    if (mesa === undefined) return Promise.reject(new MesaNoEncontradaError())
    for (const clave of Object.keys(cambios) as Array<keyof CambiosMesa>) {
      const valor = cambios[clave]
      if (valor !== undefined) Object.assign(mesa, { [clave]: valor })
    }
    return Promise.resolve({ ...mesa })
  }

  eliminarMesa(eventId: string, tableId: string): Promise<boolean> {
    const indice = this.mesas.findIndex((m) => m.id === tableId && m.eventId === eventId)
    if (indice === -1) return Promise.resolve(false)
    this.mesas.splice(indice, 1)
    this.quitarDonde((a) => a.tableId === tableId)
    return Promise.resolve(true)
  }

  listarAsignaciones(eventId: string): Promise<Asignacion[]> {
    return Promise.resolve(
      this.asignaciones
        .filter((a) => a.eventId === eventId)
        .map(({ eventId: _e, ...a }) => ({ ...a })),
    )
  }

  asignar(eventId: string, a: Asignacion): Promise<void> {
    const choca = this.asignaciones.some(
      (x) =>
        (x.tableId === a.tableId && x.seatIndex === a.seatIndex) ||
        (x.guestId === a.guestId && x.companionIndex === a.companionIndex),
    )
    if (choca) return Promise.reject(new Error('Violación de unicidad en seat_assignments'))
    this.asignaciones.push({ ...a, eventId })
    return Promise.resolve()
  }

  quitarOcupantes(eventId: string, ocupantes: Ocupante[]): Promise<void> {
    this.quitarDonde(
      (a) =>
        a.eventId === eventId &&
        ocupantes.some((o) => o.guestId === a.guestId && o.companionIndex === a.companionIndex),
    )
    return Promise.resolve()
  }

  quitarAsiento(eventId: string, tableId: string, seatIndex: number): Promise<void> {
    this.quitarDonde(
      (a) => a.eventId === eventId && a.tableId === tableId && a.seatIndex === seatIndex,
    )
    return Promise.resolve()
  }

  buscarInvitado(eventId: string, guestId: string): Promise<InvitadoSentable | null> {
    const i = this.invitados.find((x) => x.id === guestId && x.eventId === eventId)
    if (i === undefined) return Promise.resolve(null)
    const { eventId: _e, ...invitado } = i
    return Promise.resolve(invitado)
  }

  listarInvitados(eventId: string): Promise<InvitadoSentable[]> {
    return Promise.resolve(
      this.invitados.filter((i) => i.eventId === eventId).map(({ eventId: _e, ...i }) => i),
    )
  }

  private quitarDonde(predicado: (a: AsignacionGuardada) => boolean): void {
    for (let i = this.asignaciones.length - 1; i >= 0; i -= 1) {
      const a = this.asignaciones[i]
      if (a !== undefined && predicado(a)) this.asignaciones.splice(i, 1)
    }
  }
}
