import { encodeCursor, type CursorPage } from '@/shared/domain'

import type {
  NotificationRepository,
  OpcionesListado,
} from '../application/notification.repository'
import type { Notificacion } from '../domain/notification'

export interface NotificacionEnMemoria extends Notificacion {
  eventId: string
  userId: string
}

/**
 * Doble en memoria de `NotificationRepository` (ruling H1). No es más
 * permisivo que el de Prisma: filtra SIEMPRE por evento y usuario, el orden es
 * el mismo (`createdAt` y luego `id`, descendentes), marcar dos veces conserva
 * el primer `readAt` y una notificación ajena es "no existe".
 */
export class NotificationRepositoryEnMemoria implements NotificationRepository {
  readonly filas: NotificacionEnMemoria[] = []
  private readonly miembros = new Map<string, readonly string[]>()

  /** Los `userId` con membresía ACTIVA del evento, como los leería el adaptador real. */
  registrarMiembros(eventId: string, userIds: readonly string[]): void {
    this.miembros.set(eventId, [...userIds])
  }

  listar(
    eventId: string,
    userId: string,
    { desde, limite, soloNoLeidas }: OpcionesListado,
  ): Promise<CursorPage<Notificacion>> {
    const ordenadas = this.delUsuario(eventId, userId)
      .filter((n) => !soloNoLeidas || n.readAt === null)
      .filter(
        (n) =>
          desde === null ||
          n.createdAt < desde.createdAt ||
          (n.createdAt.getTime() === desde.createdAt.getTime() && n.id < desde.id),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))

    const pagina = ordenadas.slice(0, limite)
    const ultimo = pagina.at(-1)
    return Promise.resolve({
      items: pagina.map(({ eventId: _e, userId: _u, ...vista }) => ({ ...vista })),
      nextCursor: ordenadas.length > limite && ultimo !== undefined ? encodeCursor(ultimo) : null,
    })
  }

  contarNoLeidas(eventId: string, userId: string): Promise<number> {
    return Promise.resolve(this.delUsuario(eventId, userId).filter((n) => n.readAt === null).length)
  }

  marcarLeida(
    eventId: string,
    userId: string,
    notificationId: string,
    ahora: Date,
  ): Promise<boolean> {
    const fila = this.delUsuario(eventId, userId).find((n) => n.id === notificationId)
    if (fila === undefined) return Promise.resolve(false)
    fila.readAt ??= ahora
    return Promise.resolve(true)
  }

  destinatarios(eventId: string): Promise<string[]> {
    return Promise.resolve([...(this.miembros.get(eventId) ?? [])])
  }

  private delUsuario(eventId: string, userId: string): NotificacionEnMemoria[] {
    return this.filas.filter((n) => n.eventId === eventId && n.userId === userId)
  }
}
