import { Inject, Injectable } from '@nestjs/common'

import type { CursorPage } from '@/shared/domain'

import type { NotificacionConEvento } from '../domain/notification'
import {
  NOTIFICATION_REPOSITORY,
  type NotificationRepository,
  type OpcionesListado,
} from './notification.repository'

export interface PaginaDeMisNotificaciones extends CursorPage<NotificacionConEvento> {
  /** No leídas visibles del usuario en TODOS sus eventos, no sólo las de esta página. */
  unreadCount: number
}

/**
 * La campana global: las notificaciones del usuario mezclando todos sus
 * eventos, más recientes primero, cada una con el nombre de su evento, y
 * cuántas le quedan por leer en total.
 *
 * Lista y contador salen del repositorio con la MISMA regla de visibilidad
 * (membresía ACTIVE), así que la insignia nunca discrepa de lo que se ve.
 * Alternativa descartada: sumar los contadores por evento aquí, que obligaría a
 * conocer los eventos del usuario y duplicaría la regla fuera de la consulta.
 */
@Injectable()
export class ListMyNotificationsUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificaciones: NotificationRepository,
  ) {}

  async ejecutar(userId: string, opciones: OpcionesListado): Promise<PaginaDeMisNotificaciones> {
    const [pagina, unreadCount] = await Promise.all([
      this.notificaciones.listarDeUsuario(userId, opciones),
      this.notificaciones.contarNoLeidasDeUsuario(userId),
    ])
    return { ...pagina, unreadCount }
  }
}
