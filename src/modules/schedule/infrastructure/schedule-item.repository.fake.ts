import { randomUUID } from 'node:crypto'

import type {
  CambiosItem,
  DatosNuevoItem,
  ScheduleItemRepository,
} from '../application/schedule-item.repository'
import { ItemDeCronogramaNoEncontradoError } from '../domain/schedule-errors'
import type { ScheduleItem } from '../domain/schedule-item'

export class ScheduleItemRepositoryEnMemoria implements ScheduleItemRepository {
  readonly items: ScheduleItem[] = []

  listarPorEvento(eventId: string): Promise<ScheduleItem[]> {
    return Promise.resolve(
      this.items
        .filter((i) => i.eventId === eventId)
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.id < b.id ? -1 : 1))
        .map((i) => ({ ...i })),
    )
  }

  buscarPorId(eventId: string, itemId: string): Promise<ScheduleItem | null> {
    const item = this.items.find((i) => i.id === itemId && i.eventId === eventId)
    return Promise.resolve(item === undefined ? null : { ...item })
  }

  crear(datos: DatosNuevoItem): Promise<ScheduleItem> {
    const ahora = new Date()
    const item: ScheduleItem = { ...datos, id: randomUUID(), createdAt: ahora, updatedAt: ahora }
    this.items.push(item)
    return Promise.resolve({ ...item })
  }

  actualizar(eventId: string, itemId: string, cambios: CambiosItem): Promise<ScheduleItem> {
    const item = this.items.find((i) => i.id === itemId && i.eventId === eventId)
    if (item === undefined) return Promise.reject(new ItemDeCronogramaNoEncontradoError())
    Object.assign(
      item,
      Object.fromEntries(Object.entries(cambios).filter(([, valor]) => valor !== undefined)),
    )
    item.updatedAt = new Date()
    return Promise.resolve({ ...item })
  }

  eliminar(eventId: string, itemId: string): Promise<boolean> {
    const indice = this.items.findIndex((i) => i.id === itemId && i.eventId === eventId)
    if (indice === -1) return Promise.resolve(false)
    this.items.splice(indice, 1)
    return Promise.resolve(true)
  }
}
