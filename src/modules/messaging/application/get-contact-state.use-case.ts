import { Inject, Injectable } from '@nestjs/common'

import { estadoDeContacto, type EstadoDeContacto } from '../domain/perfil'
import { FichaNoDisponibleError } from '../domain/messaging-errors'
import { CONVERSATION_REPOSITORY, type ConversationRepository } from './conversation.repository'

/**
 * Estado del contacto entre `userId` y una ficha, tal como lo ve él (spec
 * 2026-11-03 §4.2). Ficha inexistente → 404. Una ficha NO publicada sólo se
 * revela a quien ya tiene un par con ella (así un proveedor despublicado no
 * deja colgada una conversación aceptada); sin par, 404 como si no existiera.
 */
@Injectable()
export class GetContactStateUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  async ejecutar(
    userId: string,
    vendorProfileId: string,
  ): Promise<{ state: EstadoDeContacto; conversationId: string | null; retryAt: Date | null }> {
    const ficha = await this.repo.fichaParaContacto(vendorProfileId)
    if (ficha === null) throw new FichaNoDisponibleError()
    // Con la propia ficha no hay par posible: SELF, sin consultar.
    const par = ficha.userId === userId ? null : await this.repo.parDePerfil(userId, ficha.userId)
    if (!ficha.publicada && par === null) throw new FichaNoDisponibleError()
    return estadoDeContacto(userId, ficha.userId, par)
  }
}
