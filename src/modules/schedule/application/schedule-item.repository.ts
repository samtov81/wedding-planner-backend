import type { Ubicacion } from '@/shared/domain'

import type { ScheduleItem, ScheduleItemStatus } from '../domain/schedule-item'

export interface DatosNuevoItem {
  eventId: string
  title: string
  description: string | null
  startsAt: Date
  endsAt: Date | null
  location: Ubicacion | null
  status: ScheduleItemStatus
}

export interface CambiosItem {
  title?: string | undefined
  description?: string | null | undefined
  startsAt?: Date | undefined
  endsAt?: Date | null | undefined
  location?: Ubicacion | null | undefined
  status?: ScheduleItemStatus | undefined
}

export interface ScheduleItemRepository {
  listarPorEvento(eventId: string): Promise<ScheduleItem[]> // startsAt asc, id asc
  buscarPorId(eventId: string, itemId: string): Promise<ScheduleItem | null>
  crear(datos: DatosNuevoItem): Promise<ScheduleItem>
  actualizar(eventId: string, itemId: string, cambios: CambiosItem): Promise<ScheduleItem> // 404 si no existe
  eliminar(eventId: string, itemId: string): Promise<boolean> // false si no existía
}

export const SCHEDULE_ITEM_REPOSITORY = Symbol('SCHEDULE_ITEM_REPOSITORY')
