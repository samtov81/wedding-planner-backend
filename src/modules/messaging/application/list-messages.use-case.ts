import { Inject, Injectable } from '@nestjs/common'

import type { CursorPage, CursorValue } from '@/shared/domain'

import { resumenDeLectura } from '../domain/sala'
import { ConversacionNoEncontradaError } from '../domain/messaging-errors'
import {
  CONVERSATION_REPOSITORY,
  type ConversacionVista,
  type ConversationRepository,
  type MarcaDeMiembro,
  type MensajeVista,
} from './conversation.repository'
import { localizarConversacion } from './localizar-conversacion'

/** "Leído por N de M" de uno de MIS mensajes de sala, con sus destinatarios. */
export interface ReciboDeSala {
  recipientIds: string[]
  total: number
  delivered: number
  read: number
}

export type PaginaDeMensajes =
  | {
      tipo: 'directa'
      pagina: CursorPage<MensajeVista>
      otherMarks: ConversacionVista['otherMarks']
    }
  | {
      tipo: 'sala'
      pagina: CursorPage<MensajeVista>
      marks: MarcaDeMiembro[]
      /** Sólo de los mensajes de quien pide: de los ajenos no ve a quién iban. */
      recibos: Map<string, ReciboDeSala>
    }

/**
 * Una página de mensajes (más recientes primero) más lo necesario para pintar
 * sus estados. En una 1:1, las marcas del otro. En una sala, las marcas de
 * todos los participantes y, en MIS mensajes, sus destinatarios y "N de M"
 * (que el cliente puede recalcular al llegar un `message.receipt`). Quien
 * salió de la sala sólo ve hasta su `visibleHasta`. Una conversación ajena o
 * invisible es un 404 idéntico al de un id inexistente.
 */
@Injectable()
export class ListMessagesUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  async ejecutar(
    userId: string,
    conversationId: string,
    opciones: { desde: CursorValue | null; limite: number },
  ): Promise<PaginaDeMensajes> {
    const localizada = await localizarConversacion(this.repo, conversationId, userId)
    if (localizada === null) throw new ConversacionNoEncontradaError()
    if (localizada.tipo === 'directa') {
      const pagina = await this.repo.mensajes(conversationId, opciones)
      return { tipo: 'directa', pagina, otherMarks: localizada.vista.otherMarks }
    }

    const sala = localizada.vista
    const pagina = await this.repo.mensajes(conversationId, {
      ...opciones,
      ...(sala.readOnly ? { hasta: sala.visibleHasta } : {}),
    })
    const mios = pagina.items.filter((m) => m.senderId === userId)
    const [marks, destinatarios] = await Promise.all([
      this.repo.marcasDeSala(conversationId),
      mios.length === 0
        ? new Map<string, string[]>()
        : this.repo.destinatariosDe(mios.map((m) => m.id)),
    ])
    const porId = new Map(marks.map((m) => [m.userId, m]))
    const recibos = new Map<string, ReciboDeSala>()
    for (const m of mios) {
      const recipientIds = destinatarios.get(m.id) ?? []
      const resumen = resumenDeLectura(recipientIds, porId, { at: m.createdAt, id: m.id })
      recibos.set(m.id, { recipientIds, ...resumen })
    }
    return { tipo: 'sala', pagina, marks, recibos }
  }
}
