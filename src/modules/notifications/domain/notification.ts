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
 * Una notificación vista desde la campana global del usuario: la misma fila más
 * el evento al que pertenece, porque ahí se mezclan las de varios eventos y la
 * interfaz necesita decir de cuál es cada una. Sólo `id` y `name`: lo demás del
 * evento no es de este módulo.
 */
export interface NotificacionConEvento extends Notificacion {
  event: { id: string; name: string }
}

/**
 * Evento de socket que avisa a un usuario de que tiene una notificación nueva.
 * Va a su sala personal, así que le llega aunque no esté mirando ese evento.
 */
export const NOTIFICACION_CREADA = 'notification.created'
