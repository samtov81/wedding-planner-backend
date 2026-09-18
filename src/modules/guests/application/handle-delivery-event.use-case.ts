import { Inject, Injectable, Logger } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import type { InvitationStatus } from '../domain/invitation'
import { INVITATION_REPOSITORY, type InvitationRepository } from './invitation.repository'

/**
 * Nombre del job en la cola `notifications` y del evento de socket que emite
 * su worker (Tarea 15) cuando el proveedor cambia el estado de una invitación.
 */
export const TIPO_ESTADO_INVITACION = 'guest.invitation.status'

/** Los estados a los que un webhook puede llevar una invitación (`mapearEstadoResend`). */
export type EstadoDeEntrega = Extract<InvitationStatus, 'DELIVERED' | 'BOUNCED' | 'COMPLAINED'>

/** Lo que recibe el worker de `notifications`. Sin correos ni tokens: va a Redis. */
export interface JobEstadoInvitacion {
  eventId: string
  payload: { guestId: string; invitationId: string; status: EstadoDeEntrega }
}

/**
 * Una invitación pasa por cada estado A LO SUMO una vez (el estado sólo
 * avanza), así que invitación + estado identifican la transición: un segundo
 * encolado de la misma no crea otro job. Con `-`, nunca `:`.
 */
export function jobIdDeEstadoInvitacion(invitationId: string, estado: EstadoDeEntrega): string {
  return `invitation-status-${invitationId}-${estado}`
}

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
export function mapearEstadoResend(type: string): EstadoDeEntrega | null {
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
  private readonly registro = new Logger(HandleDeliveryEventUseCase.name)

  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly invitaciones: InvitationRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  /**
   * NO lee antes de escribir: la monotonía del estado la aplica el repositorio
   * dentro del propio UPDATE (ver `estadosQuePuedenAvanzarA`). Un "leo, comparo
   * y escribo" aquí dejaría una ventana en la que dos webhooks concurrentes
   * leen SENT y el más lento pisa al otro.
   *
   * Un `messageId` que no casa con ninguna invitación NO lanza: afecta a 0
   * filas. Puede ser un correo que no es una invitación (otro envío de la misma
   * cuenta de Resend) o una invitación borrada; ninguno se arregla reintentando.
   *
   * Tarea 15: por cada invitación que AVANZÓ de verdad se encola
   * `guest.invitation.status` en `notifications`, y el worker lo emite a quien
   * planifica el evento. Sólo las que avanzaron: un webhook repetido o tardío
   * no cambia nada y no avisa de nada. Sin `Notification` persistida detrás:
   * el estado persistido es la propia invitación, que el REST ya sirve.
   *
   * Encolar va DESPUÉS de escribir y un fallo se registra y se traga (mismo
   * criterio que el RSVP, ruling C23): fallar el webhook haría que Resend lo
   * reintentara, pero el reintento ya no avanza nada —el estado está escrito—,
   * así que tampoco encolaría. Lo único que se pierde es la latencia.
   */
  async ejecutar(evento: EventoEntrega): Promise<void> {
    const estado = mapearEstadoResend(evento.type)
    if (estado === null) return

    const avanzadas = await this.invitaciones.actualizarEstadoPorMessageId(evento.messageId, estado)

    for (const { invitationId, guestId, eventId } of avanzadas) {
      const job: JobEstadoInvitacion = {
        eventId,
        payload: { guestId, invitationId, status: estado },
      }
      try {
        await this.cola.enqueue('notifications', TIPO_ESTADO_INVITACION, job, {
          jobId: jobIdDeEstadoInvitacion(invitationId, estado),
        })
      } catch (error) {
        this.registro.warn(
          `Estado de invitación escrito pero su aviso no se pudo encolar eventId=${eventId} ` +
            `invitationId=${invitationId}: ` +
            (error instanceof Error ? error.message : String(error)),
        )
      }
    }
  }
}
