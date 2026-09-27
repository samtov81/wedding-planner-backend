import { Inject, Injectable } from '@nestjs/common'

import { NotificacionNoEncontradaError } from '../domain/notification-errors'
import { NOTIFICATION_REPOSITORY, type NotificationRepository } from './notification.repository'

/**
 * Marca como leída una notificación PROPIA. Idempotente: marcarla dos veces no
 * es un error ni cambia cuándo se leyó. Una ajena o de otro evento es 404,
 * igual que una que no existe.
 */
@Injectable()
export class MarkReadUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificaciones: NotificationRepository,
  ) {}

  async ejecutar(eventId: string, userId: string, notificationId: string): Promise<void> {
    const marcada = await this.notificaciones.marcarLeida(
      eventId,
      userId,
      notificationId,
      new Date(),
    )
    if (!marcada) throw new NotificacionNoEncontradaError()
  }
}
