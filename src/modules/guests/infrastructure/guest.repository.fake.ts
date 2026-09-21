import { randomUUID } from 'node:crypto'

import { encodeCursor, type CursorPage, type CursorValue } from '@/shared/domain'

import type {
  CambiosInvitado,
  DatosCrearInvitado,
  GuestFilters,
  GuestRepository,
} from '../application/guest.repository'
import type { Guest, RsvpStatus } from '../domain/guest'
import { EmailDuplicadoError } from '../domain/guest-errors'

/**
 * Doble en memoria del puerto (ruling H1: vive junto a él). Repite las tres
 * cosas que el adaptador real hace y un doble ingenuo se salta, porque saltarse
 * cualquiera de ellas da verdes falsos en los tests de casos de uso:
 *
 *  1. el orden estable (createdAt, id) y el cursor sobre esa tupla,
 *  2. la búsqueda `q` sin distinguir mayúsculas sobre nombre y correo,
 *  3. el índice único PARCIAL (eventId, email) — que NO estorba a los
 *     invitados sin correo.
 *
 * `prisma-guest.repository.test.ts` compara las dos implementaciones sobre las
 * mismas filas para que no deriven en silencio.
 */
export class GuestRepositoryEnMemoria implements GuestRepository {
  readonly filas: Guest[] = []

  /** Siembra una fila tal cual, sin pasar por las reglas de `crear`. */
  sembrar(invitado: Guest): void {
    this.filas.push({ ...invitado })
  }

  listar(
    eventId: string,
    filtros: GuestFilters,
    cursor: CursorValue | null,
    limite: number,
  ): Promise<CursorPage<Guest>> {
    const q = filtros.q?.toLowerCase()

    const candidatas = this.ordenadas(eventId)
      .filter((g) => (filtros.rsvp === undefined ? true : g.rsvp === filtros.rsvp))
      .filter((g) => (filtros.group === undefined ? true : g.group === filtros.group))
      .filter((g) =>
        q === undefined
          ? true
          : g.name.toLowerCase().includes(q) || (g.email?.toLowerCase().includes(q) ?? false),
      )
      .filter((g) => (cursor === null ? true : esPosteriorA(g, cursor)))

    const hayMas = candidatas.length > limite
    const items = candidatas.slice(0, limite)
    const ultimo = items.at(-1)

    return Promise.resolve({
      items: items.map((g) => ({ ...g })),
      nextCursor: hayMas && ultimo !== undefined ? encodeCursor(ultimo) : null,
    })
  }

  contarPorEstado(eventId: string): Promise<Record<RsvpStatus, number>> {
    const base: Record<RsvpStatus, number> = { CONFIRMED: 0, PENDING: 0, DECLINED: 0 }
    for (const fila of this.filas) if (fila.eventId === eventId) base[fila.rsvp] += 1
    return Promise.resolve(base)
  }

  crear(datos: DatosCrearInvitado): Promise<Guest> {
    if (datos.email !== null && this.correoOcupado(datos.eventId, datos.email, null)) {
      return Promise.reject(new EmailDuplicadoError())
    }

    const fila: Guest = {
      id: randomUUID(),
      eventId: datos.eventId,
      name: datos.name,
      email: datos.email,
      group: datos.group,
      rsvp: 'PENDING',
      dietary: datos.dietary,
      // Marca creciente: dos `crear()` seguidos deben quedar en orden, como en
      // Postgres. Con una constante fija el cursor no distinguiría filas.
      createdAt: new Date(Date.UTC(2026, 0, 1) + this.filas.length),
    }
    this.filas.push(fila)
    return Promise.resolve({ ...fila })
  }

  buscar(eventId: string, guestId: string): Promise<Guest | null> {
    const fila = this.filas.find((g) => g.id === guestId && g.eventId === eventId)
    return Promise.resolve(fila === undefined ? null : { ...fila })
  }

  actualizar(eventId: string, guestId: string, cambios: CambiosInvitado): Promise<Guest> {
    const fila = this.filas.find((g) => g.id === guestId && g.eventId === eventId)
    if (fila === undefined) return Promise.reject(new Error('fila inexistente en el doble'))

    if (
      cambios.email !== undefined &&
      cambios.email !== null &&
      this.correoOcupado(eventId, cambios.email, guestId)
    ) {
      return Promise.reject(new EmailDuplicadoError())
    }

    if (cambios.name !== undefined) fila.name = cambios.name
    if (cambios.email !== undefined) fila.email = cambios.email
    if (cambios.group !== undefined) fila.group = cambios.group
    if (cambios.rsvp !== undefined) fila.rsvp = cambios.rsvp
    if (cambios.dietary !== undefined) fila.dietary = cambios.dietary

    return Promise.resolve({ ...fila })
  }

  borrar(eventId: string, guestId: string): Promise<void> {
    const indice = this.filas.findIndex((g) => g.id === guestId && g.eventId === eventId)
    if (indice !== -1) this.filas.splice(indice, 1)
    return Promise.resolve()
  }

  listarTodos(eventId: string): Promise<Guest[]> {
    return Promise.resolve(this.ordenadas(eventId).map((g) => ({ ...g })))
  }

  private ordenadas(eventId: string): Guest[] {
    return this.filas
      .filter((g) => g.eventId === eventId)
      .sort((a, b) => {
        const porFecha = a.createdAt.getTime() - b.createdAt.getTime()
        if (porFecha !== 0) return porFecha
        // Comparación byte a byte, no `localeCompare`: Postgres ordena los
        // uuid por bytes y una colación de locale daría otro orden.
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
  }

  private correoOcupado(eventId: string, email: string, salvoId: string | null): boolean {
    return this.filas.some((g) => g.eventId === eventId && g.email === email && g.id !== salvoId)
  }
}

/** Misma comparación lexicográfica de (createdAt, id) que hace el `WHERE` real. */
function esPosteriorA(invitado: Guest, cursor: CursorValue): boolean {
  const suyo = invitado.createdAt.getTime()
  const delCursor = cursor.createdAt.getTime()
  if (suyo !== delCursor) return suyo > delCursor
  return invitado.id > cursor.id
}
