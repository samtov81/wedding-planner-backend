/**
 * Una notificación persistida, tal como la ve su destinatario. `payload` es la
 * columna `Json` tal cual: lo que escribió quien la creó, sin forma común entre
 * tipos (cada `type` define la suya).
 */
export interface Notificacion {
  id: string
  type: string
  payload: unknown
  readAt: Date | null
  createdAt: Date
}

/**
 * Evento de socket que avisa a un usuario de que tiene una notificación nueva.
 * Va a su sala personal, así que le llega aunque no esté mirando ese evento.
 */
export const NOTIFICACION_CREADA = 'notification.created'
