import type { MarcasDeParticipante, MensajeVista } from '../application/conversation.repository'
import type { Marca } from '../domain/conversacion'

/**
 * La forma en el cable de un mensaje y de las marcas: la comparten REST
 * (`ConversationsController`) y el socket (`MessagingProcessor`), para que un
 * cliente lea lo mismo venga por donde venga.
 */
export interface MarcaJson {
  at: string
  id: string
}

export interface MensajeJson {
  id: string
  conversationId: string
  senderId: string
  body: string
  createdAt: string
}

export interface OtherMarksJson {
  deliveredUpTo: MarcaJson | null
  readUpTo: MarcaJson | null
}

export const marcaJson = (m: Marca | null): MarcaJson | null =>
  m === null ? null : { at: m.at.toISOString(), id: m.id }

export const otherMarksJson = (m: MarcasDeParticipante): OtherMarksJson => ({
  deliveredUpTo: marcaJson(m.deliveredUpTo),
  readUpTo: marcaJson(m.readUpTo),
})

export const mensajeJson = (m: MensajeVista): MensajeJson => ({
  id: m.id,
  conversationId: m.conversationId,
  senderId: m.senderId,
  body: m.body,
  createdAt: m.createdAt.toISOString(),
})
