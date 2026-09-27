import type { Ubicacion } from '@/shared/domain'

export type ScheduleItemStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE'

/**
 * Un momento del día del evento ("Inicio de la fiesta"). `location` null =
 * mismo lugar que el evento; el cliente decide cómo pintarlo. Los instantes
 * son UTC; el frontend los muestra en la `timezone` del evento.
 */
export interface ScheduleItem {
  id: string
  eventId: string
  title: string
  description: string | null
  startsAt: Date
  endsAt: Date | null
  location: Ubicacion | null
  status: ScheduleItemStatus
  createdAt: Date
  updatedAt: Date
}

export function rangoValido(startsAt: Date, endsAt: Date | null): boolean {
  return endsAt === null || endsAt.getTime() >= startsAt.getTime()
}
