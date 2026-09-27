import { Inject, Injectable } from '@nestjs/common'

import type { CursorPage } from '@/shared/domain'

import type { Notificacion } from '../domain/notification'
import {
  NOTIFICATION_REPOSITORY,
  type NotificationRepository,
  type OpcionesListado,
} from './notification.repository'

export interface PaginaDeNotificaciones extends CursorPage<Notificacion> {
  /** No leídas del usuario en el evento, TODAS, no sólo las de esta página. */
  unreadCount: number
}

/**
 * Lo que un cliente que estuvo desconectado recupera: las notificaciones del
 * usuario en el evento, más recientes primero, y cuántas le quedan por leer.
 * El socket es latencia; esto es el canal.
 */
@Injectable()
export class ListNotificationsUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificaciones: NotificationRepository,
  ) {}

  async ejecutar(
    eventId: string,
    userId: string,
    opciones: OpcionesListado,
  ): Promise<PaginaDeNotificaciones> {
    const [pagina, unreadCount] = await Promise.all([
      this.notificaciones.listar(eventId, userId, opciones),
      this.notificaciones.contarNoLeidas(eventId, userId),
    ])
    return { ...pagina, unreadCount }
  }
}
