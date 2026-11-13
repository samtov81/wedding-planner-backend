import { Inject, Injectable } from '@nestjs/common'

import { SubidaDeAdjuntos } from '@/modules/storage/application/subida-de-adjuntos'
import type { SubidaPreparada } from '@/modules/storage/application/subida-directa'
import { AlmacenamientoNoDisponibleError } from '@/modules/storage/domain/imagen'

import { alcanza } from '../domain/conversacion'
import {
  AdjuntosNoPermitidosError,
  ConversacionNoEncontradaError,
  ConversacionSoloLecturaError,
} from '../domain/messaging-errors'
import {
  ADJUNTOS_DE_MENSAJES,
  type AdjuntosDeMensajes,
  type AdjuntoVisible,
} from './adjuntos-de-mensajes.port'
import { CONVERSATION_REPOSITORY, type ConversationRepository } from './conversation.repository'
import { localizarConversacion } from './localizar-conversacion'

/**
 * Prefijo en R2 de los adjuntos de una conversación (spec 2026-11-12 §7). Va
 * bajo el evento para que todo lo de un evento cuelgue de `events/<eventId>/`
 * y por conversación para que `confirmar` rechace una key subida para otra
 * conversación (aunque sea del mismo evento y de quien envía).
 */
export function prefijoAdjuntos(eventId: string, conversationId: string): string {
  return `events/${eventId}/messages/${conversationId}`
}

/**
 * Implementación del puerto público `ADJUNTOS_DE_MENSAJES`. Regla de
 * visibilidad (spec §5): quien ve el MENSAJE en `GET /conversations/:id/messages`
 * ve su adjunto, ni más ni menos. Por eso no se inventa nada aquí:
 *
 *  - Se localiza la conversación con `localizarConversacion`, el único sitio
 *    que decide si `userId` la ve (null → no lo ve).
 *  - `PROFILE` nunca: no admite adjuntos y no tiene evento.
 *  - En la sala, un miembro de hoy ve todo el historial (también lo anterior a
 *    su entrada). Quien salió (`readOnly`) sólo ve hasta `visibleHasta`, con la
 *    misma comparación `alcanza` que aplica `mensajes(..., { hasta })`: con
 *    `visibleHasta === null` no ve ningún mensaje.
 *  - En una 1:1 en solo lectura se sigue viendo todo, como en el listado.
 *
 * Alternativa descartada: filtrar la sala por `MessageRecipient` (los
 * destinatarios fijados al enviar). Dejaría a un miembro que entró tarde sin
 * poder abrir un archivo que sí ve en la lista, y la lista nunca debe enseñar
 * un adjunto que no se puede abrir. `MessageRecipient` sirve sólo para el
 * "leído por N de M".
 */
@Injectable()
export class BuscarAdjuntoVisible implements AdjuntosDeMensajes {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  async buscarVisible(userId: string, messageId: string): Promise<AdjuntoVisible | null> {
    const adjunto = await this.repo.adjuntoDe(messageId)
    if (adjunto === null || adjunto.eventId === null) return null
    const localizada = await localizarConversacion(this.repo, adjunto.conversationId, userId)
    if (localizada === null || localizada.tipo === 'perfil') return null
    if (
      localizada.tipo === 'sala' &&
      localizada.vista.readOnly &&
      !alcanza(localizada.vista.visibleHasta, { at: adjunto.createdAt, id: adjunto.messageId })
    ) {
      return null
    }
    return {
      messageId: adjunto.messageId,
      eventId: adjunto.eventId,
      conversationId: adjunto.conversationId,
      senderId: adjunto.senderId,
      key: adjunto.key,
      name: adjunto.name,
      contentType: adjunto.contentType,
      bytes: adjunto.bytes,
    }
  }
}

/**
 * Primera mitad de enviar un adjunto: firma un PUT directo a R2 bajo el
 * prefijo de la conversación. Se exige lo mismo que para escribir: verla
 * (si no, el 404 de un id inexistente), que no sea `PROFILE` (422) y que no
 * esté en solo lectura (403). Así no se firma una subida que el envío
 * rechazaría después. Tipo y tamaño los valida `SubidaDeAdjuntos`
 * (`INVALID_ATTACHMENT`). Alternativa descartada: firmar sin mirar la
 * conversación y dejar la comprobación al envío; cualquiera con sesión podría
 * llenar el bucket bajo prefijos ajenos.
 */
@Injectable()
export class PrepararSubidaAdjuntoUseCase {
  constructor(
    @Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository,
    private readonly subidas: SubidaDeAdjuntos,
  ) {}

  async ejecutar(
    userId: string,
    conversationId: string,
    contentType: string,
    bytes: number,
  ): Promise<SubidaPreparada> {
    const localizada = await localizarConversacion(this.repo, conversationId, userId)
    if (localizada === null) throw new ConversacionNoEncontradaError()
    if (localizada.tipo === 'perfil') throw new AdjuntosNoPermitidosError()
    if (localizada.vista.readOnly) throw new ConversacionSoloLecturaError()
    return this.subidas.preparar(
      prefijoAdjuntos(localizada.vista.event.id, conversationId),
      contentType,
      bytes,
    )
  }
}

/**
 * URL de descarga de vida corta del adjunto de un mensaje, con su nombre
 * original. Pasa por el puerto público (`buscarVisible`) para que la descarga
 * y la conversión en factura apliquen exactamente la misma regla. Un mensaje
 * que no ve, sin adjunto, inexistente o de OTRA conversación que la de la
 * ruta es el mismo 404 (`CONVERSATION_NOT_FOUND`): la ruta no debe servir
 * para sondear ids. Sin almacén configurado, 503.
 */
@Injectable()
export class DescargarAdjuntoUseCase {
  constructor(
    @Inject(ADJUNTOS_DE_MENSAJES) private readonly adjuntos: AdjuntosDeMensajes,
    private readonly subidas: SubidaDeAdjuntos,
  ) {}

  async ejecutar(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<{ url: string }> {
    const adjunto = await this.adjuntos.buscarVisible(userId, messageId)
    if (adjunto === null || adjunto.conversationId !== conversationId) {
      throw new ConversacionNoEncontradaError()
    }
    const url = await this.subidas.firmarLectura(adjunto.key, adjunto.name)
    if (url === null) throw new AlmacenamientoNoDisponibleError()
    return { url }
  }
}
