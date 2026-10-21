import { Inject, Injectable } from '@nestjs/common'

import { NOTIFICATION_REPOSITORY, type NotificationRepository } from './notification.repository'

/**
 * "Marcar todas como leídas" de la campana global. Idempotente: sin nada por
 * leer no hace nada y tampoco es un error (la ruta responde 204 igual). Sólo
 * toca las visibles; las de un evento donde ya no es miembro quedan intactas.
 * No devuelve el número marcado: el cliente relee la lista y el contador.
 */
@Injectable()
export class MarkAllReadUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificaciones: NotificationRepository,
  ) {}

  async ejecutar(userId: string): Promise<void> {
    await this.notificaciones.marcarTodasLeidas(userId, new Date())
  }
}
