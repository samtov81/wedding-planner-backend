/**
 * El adjunto de un mensaje que `userId` puede ver, con la key del objeto y el
 * evento al que pertenece. Sólo existe para mensajes de conversaciones de
 * evento (`EVENT_DIRECT` y `EVENT_ROOM`): una `PROFILE` no admite adjuntos y
 * no tiene evento, así que `eventId` nunca es null aquí.
 */
export interface AdjuntoVisible {
  messageId: string
  eventId: string
  conversationId: string
  senderId: string
  key: string
  name: string
  contentType: string
  bytes: number
}

/**
 * Puerto PÚBLICO de mensajería (lo exporta `MessagingModule`): otros módulos
 * (presupuesto, al convertir un adjunto en factura) preguntan por el adjunto
 * de un mensaje sin conocer el repositorio de conversaciones ni repetir la
 * regla de visibilidad. `null` = el mensaje no existe, no lleva adjunto o
 * `userId` no lo ve; los tres casos son indistinguibles a propósito (un 404
 * idéntico no confirma que un id ajeno exista).
 */
export interface AdjuntosDeMensajes {
  buscarVisible(userId: string, messageId: string): Promise<AdjuntoVisible | null>
}

export const ADJUNTOS_DE_MENSAJES = Symbol('ADJUNTOS_DE_MENSAJES')
