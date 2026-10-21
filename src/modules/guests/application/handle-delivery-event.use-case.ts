import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import {
  NOTIFICATION_PORT,
  type NotificationPort,
} from '@/modules/notifications/application/notification.port'
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
    @Inject(NOTIFICATION_PORT) private readonly notificaciones: NotificationPort,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
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
   * no cambia nada y no avisa de nada.
   *
   * Rebote y queja de spam SÍ llevan `Notification` detrás: son lo único que
   * requiere acción de la pareja (corregir el correo del invitado). Una
   * entrega correcta no: su estado persistido es la propia invitación, que el
   * REST ya sirve, y el aviso en tiempo real basta. Mapeo tipo → permiso →
   * vista: `guest.invitation.status` (BOUNCED|COMPLAINED) → `COUPLE|PLANNER`
   * → `/events/:id/guests`. Esa vista exige COUPLE|PLANNER y todo miembro
   * ACTIVO tiene uno de los dos, así que se notifica a todos los miembros
   * ACTIVOS (`crearParaMiembros`), como el RSVP.
   *
   * La escritura del estado y las notificaciones van en UNA transacción: un
   * rebote sin notificación sería un aviso que la pareja no ve nunca si no
   * estaba conectada. Si crearla falla, el webhook falla y Resend reintenta; el
   * reintento sí vuelve a avanzar la fila, porque la transacción deshizo el
   * UPDATE. Sólo notifican las filas que AVANZARON (el `WHERE` monótono del
   * repositorio), así que un webhook repetido no duplica nada.
   *
   * Encolar va FUERA y DESPUÉS del commit y un fallo se registra y se traga
   * (mismo criterio que el RSVP, ruling C23): la notificación ya está
   * persistida y se recupera por REST. Lo único que se pierde es la latencia.
   */
  async ejecutar(evento: EventoEntrega): Promise<void> {
    const estado = mapearEstadoResend(evento.type)
    if (estado === null) return

    const avanzadas = await this.unidadDeTrabajo.ejecutar(async () => {
      const filas = await this.invitaciones.actualizarEstadoPorMessageId(evento.messageId, estado)
      if (estado === 'BOUNCED' || estado === 'COMPLAINED') {
        for (const { invitationId, guestId, eventId, guestName } of filas) {
          await this.notificaciones.crearParaMiembros(eventId, TIPO_ESTADO_INVITACION, {
            guestId,
            guestName,
            invitationId,
            status: estado,
          })
        }
      }
      return filas
    })

    // Ninguna invitación que avanzar: un correo que no es una invitación, uno
    // borrado, o un webhook repetido. En silencio no se distingue de un evento
    // que sí debería haber cambiado algo, así que queda el rastro —en `debug`,
    // porque en una cuenta de Resend compartida es la mayoría de eventos.
    if (avanzadas.length === 0) {
      this.registro.debug(
        `Evento de Resend sin invitación que avanzar messageId=${evento.messageId}`,
      )
      return
    }

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
