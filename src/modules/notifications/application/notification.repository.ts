import type { CursorPage, CursorValue } from '@/shared/domain'

import type { Notificacion } from '../domain/notification'

export interface OpcionesListado {
  /** Posición del cursor (la última notificación de la página anterior), o `null`. */
  desde: CursorValue | null
  limite: number
  soloNoLeidas: boolean
}

/**
 * Lectura y marcado de las notificaciones de UN usuario en UN evento. Toda
 * operación lleva `eventId` y `userId`: un usuario no ve ni marca las de otro,
 * y el filtro va en la consulta, no en el caso de uso después de leer.
 *
 * La creación NO está aquí: es `NotificationPort.crearParaMiembros`, que
 * implementa el mismo adaptador de Prisma.
 */
export interface NotificationRepository {
  /** Más recientes primero; orden total (`createdAt`, `id`) para que el cursor sea exacto. */
  listar(
    eventId: string,
    userId: string,
    opciones: OpcionesListado,
  ): Promise<CursorPage<Notificacion>>

  /** Contado sobre las filas (`readAt IS NULL`), nunca un contador guardado aparte. */
  contarNoLeidas(eventId: string, userId: string): Promise<number>

  /**
   * Marca como leída. `true` si la notificación existe y es de este usuario en
   * este evento (ya estuviera leída o no: marcar dos veces no cambia su
   * `readAt` original); `false` si no existe o es ajena.
   */
  marcarLeida(
    eventId: string,
    userId: string,
    notificationId: string,
    ahora: Date,
  ): Promise<boolean>

  /**
   * Quiénes reciben las notificaciones del evento: los miembros ACTIVOS
   * (pareja y planners). La misma consulta que usa `crearParaMiembros`, así que
   * el aviso por socket llega a quien tiene la fila persistida.
   */
  destinatarios(eventId: string): Promise<string[]>
}

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY')
