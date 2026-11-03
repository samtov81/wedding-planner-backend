import { Inject, Injectable, Logger } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { alcanza } from '../domain/conversacion'
import { ConversacionNoEncontradaError } from '../domain/messaging-errors'
import { encolarAvisoRecibo } from './avisos-mensajeria'
import {
  CONVERSATION_REPOSITORY,
  type ConversationRepository,
  type MarcasDeParticipante,
} from './conversation.repository'
import { localizarConversacion } from './localizar-conversacion'

/**
 * Marca "entregado" o "leído" hasta el mensaje `upTo`. Las marcas sólo avanzan
 * (lo garantiza el repositorio). Marcar SÍ se permite en solo lectura: leer
 * lo que ya existe no es escribir. Un `upTo` de otra conversación es un 404,
 * igual que una conversación ajena.
 *
 * En la sala, quien salió sólo marca lo que ve (hasta `visibleHasta`; un
 * mensaje posterior es un 404, como si no existiera). Un miembro ACTIVE que
 * aún no tenía fila de participante (entró y no ha abierto la sala) la obtiene
 * con `abrirSala` antes de marcar.
 *
 * Devuelve las marcas resultantes y los demás participantes. Tras persistir
 * encola el recibo en tiempo real (`avisos-mensajeria.ts`); si Redis falla se
 * registra un `warn` y la respuesta no cambia.
 */
@Injectable()
export class MarkConversationUseCase {
  private readonly registro = new Logger(MarkConversationUseCase.name)

  constructor(
    @Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(
    userId: string,
    conversationId: string,
    tipo: 'delivered' | 'read',
    upTo: string,
  ): Promise<{
    conversationId: string
    marcas: MarcasDeParticipante
    destinatarios: string[]
  }> {
    const localizada = await localizarConversacion(this.repo, conversationId, userId)
    if (localizada === null) throw new ConversacionNoEncontradaError()
    if (localizada.tipo === 'sala') {
      const sala = localizada.vista
      if (sala.readOnly) {
        const mensaje = await this.repo.mensaje(conversationId, upTo)
        if (
          mensaje === null ||
          !alcanza(sala.visibleHasta, { at: mensaje.createdAt, id: mensaje.id })
        ) {
          throw new ConversacionNoEncontradaError()
        }
      } else {
        await this.repo.abrirSala(sala.event.id, userId)
      }
    }

    const marcas = await this.repo.marcar(conversationId, userId, tipo, upTo)
    if (marcas === false) throw new ConversacionNoEncontradaError()

    await encolarAvisoRecibo(this.cola, this.registro, { conversationId, userId }, marcas)
    const participantes = await this.repo.participantes(conversationId)
    return { conversationId, marcas, destinatarios: participantes.filter((p) => p !== userId) }
  }
}
