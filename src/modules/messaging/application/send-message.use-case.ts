import { Inject, Injectable, Logger } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import { SubidaDeAdjuntos } from '@/modules/storage/application/subida-de-adjuntos'

import { normalizarCuerpo, normalizarNombreDeAdjunto } from '../domain/conversacion'
import {
  AdjuntosNoPermitidosError,
  ConversacionNoEncontradaError,
  ConversacionSoloLecturaError,
  EscrituraEnSolicitudPendienteError,
} from '../domain/messaging-errors'
import { prefijoAdjuntos } from './adjuntos.use-cases'
import { encolarAvisoMensaje } from './avisos-mensajeria'
import {
  type AdjuntoGuardado,
  CONVERSATION_REPOSITORY,
  type ConversationRepository,
  type MensajeVista,
} from './conversation.repository'
import { localizarConversacion } from './localizar-conversacion'

/**
 * Envía un mensaje a una 1:1 o a la sala del evento. En la sala escribe quien
 * es miembro ACTIVE hoy (si no, `readOnly` → 403) y los destinatarios se fijan
 * al guardar (`agregarMensajeDeSala`). En una conversación de perfil
 * (parte 3) se escribe sólo con la solicitud aceptada: PENDING es 403
 * `CONTACT_REQUEST_PENDING` y DECLINED 403 `CONVERSATION_READ_ONLY`; aceptada
 * se envía como una 1:1. En una 1:1, escribir exige que AMBOS
 * participantes tengan acceso hoy:
 * si no (`readOnly`) es un 403. Quien no participa recibe el mismo 404 que con
 * un id inexistente. El cuerpo se normaliza aquí (segunda barrera tras Zod).
 *
 * Adjunto (spec 2026-11-12): sólo en conversaciones de evento; en `PROFILE`
 * es 422 `ATTACHMENTS_NOT_ALLOWED`, antes incluso de mirar si es de solo
 * lectura (la respuesta no depende del estado de la solicitud). Con adjunto
 * el cuerpo puede quedar vacío; el nombre se normaliza y la key se confirma
 * en R2 bajo `prefijoAdjuntos` ANTES de guardar (una key de otra conversación
 * es 422 `INVALID_UPLOAD`). Alternativa descartada: guardar y confirmar
 * después, que dejaría mensajes apuntando a objetos que no existen.
 *
 * Devuelve el mensaje y los demás participantes. Tras guardar, ENCOLA el aviso
 * en tiempo real (`avisos-mensajeria.ts`): guardar y avisar son pasos separados
 * y un fallo de Redis se registra pero no deshace ni falla un mensaje ya
 * guardado (la respuesta REST no cambia). El worker decide a quién emitir.
 *
 * Nota: `createdAt` sale del reloj del servidor de la API. Con pods desfasados,
 * un mensaje podría ordenarse antes de una marca ya existente (raro). El arreglo
 * sería una marca de tiempo del lado de la base, bajo un bloqueo de fila.
 */
@Injectable()
export class SendMessageUseCase {
  private readonly registro = new Logger(SendMessageUseCase.name)

  constructor(
    @Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
    private readonly subidas: SubidaDeAdjuntos,
  ) {}

  async ejecutar(
    userId: string,
    conversationId: string,
    texto: string,
    adjunto: { key: string; name: string } | null,
  ): Promise<{ mensaje: MensajeVista; destinatarios: string[] }> {
    const localizada = await localizarConversacion(this.repo, conversationId, userId)
    if (localizada === null) throw new ConversacionNoEncontradaError()
    if (adjunto !== null && localizada.tipo === 'perfil') throw new AdjuntosNoPermitidosError()
    if (localizada.vista.readOnly) {
      // Perfil: una solicitud pendiente se distingue de una rechazada (que es
      // sólo lectura). El proveedor nunca localiza una DECLINED (404).
      if (localizada.tipo === 'perfil' && localizada.vista.status === 'PENDING') {
        throw new EscrituraEnSolicitudPendienteError()
      }
      throw new ConversacionSoloLecturaError()
    }

    const cuerpo = normalizarCuerpo(texto, adjunto !== null)
    // El perfil ya salió arriba si traía adjunto: aquí sólo llega uno de evento.
    const guardado =
      adjunto === null || localizada.tipo === 'perfil'
        ? null
        : await this.confirmarAdjunto(localizada.vista.event.id, conversationId, adjunto)
    if (localizada.tipo === 'sala') {
      const r = await this.repo.agregarMensajeDeSala(
        conversationId,
        userId,
        cuerpo,
        new Date(),
        guardado,
      )
      await encolarAvisoMensaje(this.cola, this.registro, {
        conversationId,
        messageId: r.mensaje.id,
      })
      return r
    }
    const mensaje = await this.repo.agregarMensaje(
      conversationId,
      userId,
      cuerpo,
      new Date(),
      guardado,
    )
    await encolarAvisoMensaje(this.cola, this.registro, { conversationId, messageId: mensaje.id })
    const participantes = await this.repo.participantes(conversationId)
    return { mensaje, destinatarios: participantes.filter((p) => p !== userId) }
  }

  /**
   * Comprueba en R2 que la key está bajo el prefijo de ESTA conversación y que
   * lo subido es válido; tipo y tamaño salen del bucket, no del cliente. Se
   * hace antes de guardar: un mensaje nunca apunta a un objeto inexistente.
   */
  private async confirmarAdjunto(
    eventId: string,
    conversationId: string,
    adjunto: { key: string; name: string },
  ): Promise<AdjuntoGuardado> {
    const name = normalizarNombreDeAdjunto(adjunto.name)
    const { contentType, bytes } = await this.subidas.confirmar(
      prefijoAdjuntos(eventId, conversationId),
      adjunto.key,
    )
    return { key: adjunto.key, name, contentType, bytes }
  }
}
