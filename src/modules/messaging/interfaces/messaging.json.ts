import type {
  Contacto,
  MarcaDeMiembro,
  MarcasDeParticipante,
  MensajeVista,
  SalaVista,
} from '../application/conversation.repository'
import type { ReciboDeSala } from '../application/list-messages.use-case'
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

/** Una sala en el cable (`GET /me/rooms`, `GET /events/:eventId/room`). */
export interface SalaJson {
  id: string
  kind: 'EVENT_ROOM'
  event: { id: string; name: string }
  memberCount: number
  lastMessage: MensajeJson | null
  unreadCount: number
  readOnly: boolean
}

export const salaJson = (s: SalaVista): SalaJson => ({
  id: s.id,
  kind: 'EVENT_ROOM',
  event: s.event,
  memberCount: s.memberCount,
  lastMessage: s.lastMessage === null ? null : mensajeJson(s.lastMessage),
  unreadCount: s.unreadCount,
  readOnly: s.readOnly,
})

export interface MarcaDeMiembroJson extends OtherMarksJson {
  userId: string
  displayName: string
  role: 'COUPLE' | 'PLANNER'
}

export const marcaDeMiembroJson = (m: MarcaDeMiembro): MarcaDeMiembroJson => ({
  userId: m.userId,
  displayName: m.displayName,
  role: m.role,
  ...otherMarksJson(m),
})

/**
 * Un miembro de la sala HOY, para la lista de participantes. Sin marcas: eso
 * es `MarcaDeMiembroJson`, que sale de filas de participante.
 */
export interface MiembroDeSalaJson {
  userId: string
  displayName: string
  role: 'COUPLE' | 'PLANNER'
}

export const miembroDeSalaJson = (c: Contacto): MiembroDeSalaJson => ({
  userId: c.userId,
  displayName: c.displayName,
  // Las membresías sólo son COUPLE/PLANNER; un VENDOR no puede llegar aquí.
  role: c.role === 'COUPLE' ? 'COUPLE' : 'PLANNER',
})

/** Un mensaje de sala; los MÍOS llevan a quién iba y "leído por N de M". */
export interface MensajeDeSalaJson extends MensajeJson {
  recipientIds?: string[]
  receipts?: { total: number; delivered: number; read: number }
}

export const mensajeDeSalaJson = (
  m: MensajeVista,
  recibo: ReciboDeSala | undefined,
): MensajeDeSalaJson =>
  recibo === undefined
    ? mensajeJson(m)
    : {
        ...mensajeJson(m),
        recipientIds: recibo.recipientIds,
        receipts: { total: recibo.total, delivered: recibo.delivered, read: recibo.read },
      }
