import { Inject, Injectable } from '@nestjs/common'

import { NOTIFICACION_CREADA } from '../domain/notification'
import { NOTIFICATION_REPOSITORY, type NotificationRepository } from './notification.repository'
import { REALTIME_PORT, type RealtimePort } from './realtime.port'

/**
 * El fan-out en tiempo real que ejecuta el worker de `notifications`. Nunca
 * persiste nada: lo que se avisa YA está confirmado en Postgres, y un cliente
 * que no estaba conectado lo recupera por REST.
 *
 * Los errores de emisión SALEN: en el worker eso es lo que hace que BullMQ
 * reintente el job. Reintentar puede repetir un aviso ya emitido (BullMQ es
 * "al menos una vez"); el cliente trata los avisos como "algo cambió, vuelve a
 * leer", así que un duplicado no hace daño.
 */
@Injectable()
export class BroadcastNoticeUseCase {
  constructor(
    @Inject(REALTIME_PORT) private readonly realtime: RealtimePort,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificaciones: NotificationRepository,
  ) {}

  /**
   * Un cambio CON `Notification` persistida detrás (hoy, el RSVP): el cambio a
   * quien planifica el evento y `notification.created` a la sala personal de
   * cada destinatario, que le llega aunque no esté mirando ese evento.
   *
   * DESIGN-GAP: `notification.created` lleva `{ eventId, type }`, sin el `id`
   * de la notificación. El job que encola el RSVP (Tarea 14) no lo trae —se
   * encola después del commit con el aviso, no con las filas— y cambiar ese
   * contrato no hace falta para lo que el aviso es: la señal para que el
   * cliente vuelva a pedir `GET /events/:eventId/notifications`, que sí da ids
   * y el total de no leídas contado sobre las filas. Los destinatarios son los
   * miembros ACTIVOS en el momento de emitir; si alguien entra o sale del
   * equipo entre el commit y el worker, el aviso puede no casar con las filas
   * — el REST sí casa, siempre.
   */
  async avisarDeNotificacion(eventId: string, tipo: string, payload: unknown): Promise<void> {
    await this.realtime.emitirAEvento(eventId, tipo, payload)
    for (const userId of await this.notificaciones.destinatarios(eventId)) {
      await this.realtime.emitirAUsuario(userId, NOTIFICACION_CREADA, { eventId, type: tipo })
    }
  }

  /**
   * Un cambio SIN `Notification` (hoy, el estado de entrega de una
   * invitación): su estado persistido es la propia fila, que el REST ya sirve.
   * Sólo se avisa a la sala del evento.
   */
  async avisarDeCambio(eventId: string, tipo: string, payload: unknown): Promise<void> {
    await this.realtime.emitirAEvento(eventId, tipo, payload)
  }
}
