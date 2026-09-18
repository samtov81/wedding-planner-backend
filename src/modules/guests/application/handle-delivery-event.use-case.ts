import { Inject, Injectable } from '@nestjs/common'

import type { InvitationStatus } from '../domain/invitation'
import { INVITATION_REPOSITORY, type InvitationRepository } from './invitation.repository'

/** Evento de entrega ya verificado y validado en el borde. */
export interface EventoEntrega {
  type: string
  messageId: string
}

/**
 * Traduce el tipo de evento de Resend a nuestro estado. `null` = el evento no
 * cambia nada nuestro (`email.sent`, `opened`, `clicked`, y cualquier tipo que
 * Resend añada en el futuro): se ignora con 2xx en vez de fallar, porque un
 * error haría que el proveedor lo reintentara para siempre.
 */
export function mapearEstadoResend(type: string): InvitationStatus | null {
  switch (type) {
    case 'email.delivered':
      return 'DELIVERED'
    case 'email.bounced':
      return 'BOUNCED'
    case 'email.complained':
      return 'COMPLAINED'
    default:
      return null // opened, clicked, sent: no cambian nuestro estado
  }
}

@Injectable()
export class HandleDeliveryEventUseCase {
  constructor(@Inject(INVITATION_REPOSITORY) private readonly invitaciones: InvitationRepository) {}

  /**
   * NO lee antes de escribir: la monotonía del estado la aplica el repositorio
   * dentro del propio UPDATE (ver `estadosQuePuedenAvanzarA`). Un "leo, comparo
   * y escribo" aquí dejaría una ventana en la que dos webhooks concurrentes
   * leen SENT y el más lento pisa al otro.
   *
   * Un `messageId` que no casa con ninguna invitación NO lanza: afecta a 0
   * filas. Puede ser un correo que no es una invitación (otro envío de la misma
   * cuenta de Resend) o una invitación borrada; ninguno se arregla reintentando.
   */
  async ejecutar(evento: EventoEntrega): Promise<void> {
    const estado = mapearEstadoResend(evento.type)
    if (estado === null) return

    await this.invitaciones.actualizarEstadoPorMessageId(evento.messageId, estado)
  }
}
