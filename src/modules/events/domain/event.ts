import type { Ubicacion } from '@/shared/domain'

/**
 * Días antes de la boda en que se cierra el RSVP si la pareja no dice otra
 * cosa. Es también el `@default` de la columna: el doble en memoria lo aplica
 * igual que Postgres.
 */
export const DIAS_DE_CIERRE_POR_DEFECTO = 14

export type EventStatus = 'DRAFT' | 'ACTIVE'

export interface ConteosEvento {
  scheduleItems: number
  vendors: number
}

/**
 * El evento, tal como lo conoce el dominio. Deliberadamente NO es el tipo que
 * genera Prisma: `totalBudget` y compañía son `Decimal` del cliente, y
 * arrastrar ese tipo hasta aquí ataría el dominio al ORM.
 */
export interface Event {
  id: string
  name: string
  status: EventStatus
  weddingDate: Date | null
  timezone: string
  currency: string
  totalBudget: string | null
  venue: Ubicacion | null
  /** El RSVP cierra `weddingDate − rsvpDeadlineDays` días (bloque A §2). 0–365. */
  rsvpDeadlineDays: number
  ownerId: string
  conteos: ConteosEvento
  createdAt: Date
  updatedAt: Date
}
