import { encodeCursor, type CursorPage } from '@/shared/domain'

import { TIPO_PROVEEDOR_CONTRATADO } from '../application/notification.port'
import type {
  NotificationRepository,
  OpcionesListado,
} from '../application/notification.repository'
import type { Notificacion, NotificacionConEvento } from '../domain/notification'

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
  private readonly eventos = new Map<string, string>()
  private readonly proveedores = new Map<string, readonly string[]>()
  private readonly publicados = new Set<string>()

  /** Los `userId` con membresía ACTIVA del evento, como los leería el adaptador real. */
  registrarMiembros(eventId: string, userIds: readonly string[]): void {
    this.miembros.set(eventId, [...userIds])
  }

  /**
   * `userId` es el proveedor de una contratación BOOKED del evento. Sus avisos
   * sólo se ven con el evento PUBLICADO (como `status: 'ACTIVE'` en Prisma):
   * `publicado` (por defecto `true`) fija ese estado del evento.
   */
  registrarProveedorContratado(eventId: string, userId: string, publicado = true): void {
    this.fijarPublicado(eventId, publicado)
    const actuales = this.proveedores.get(eventId) ?? []
    if (!actuales.includes(userId)) this.proveedores.set(eventId, [...actuales, userId])
  }

  /** Publica (`true`) o devuelve a borrador (`false`) el evento, como `Event.status`. */
  fijarPublicado(eventId: string, publicado: boolean): void {
    if (publicado) this.publicados.add(eventId)
    else this.publicados.delete(eventId)
  }

  /** La contratación se cancela: deja de ser visible, como en el adaptador real. */
  quitarProveedorContratado(eventId: string, userId: string): void {
    this.proveedores.set(
      eventId,
      (this.proveedores.get(eventId) ?? []).filter((id) => id !== userId),
    )
  }

  /** El nombre con el que `listarDeUsuario` etiqueta las notificaciones de ese evento. */
  registrarEvento(eventId: string, name: string): void {
    this.eventos.set(eventId, name)
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

  listarDeUsuario(
    userId: string,
    { desde, limite, soloNoLeidas }: OpcionesListado,
  ): Promise<CursorPage<NotificacionConEvento>> {
    const ordenadas = this.visiblesDe(userId)
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
      items: pagina.map(({ eventId, userId: _u, ...vista }) => ({
        ...vista,
        event: { id: eventId, name: this.nombreDe(eventId) },
      })),
      nextCursor: ordenadas.length > limite && ultimo !== undefined ? encodeCursor(ultimo) : null,
    })
  }

  contarNoLeidasDeUsuario(userId: string): Promise<number> {
    return Promise.resolve(this.visiblesDe(userId).filter((n) => n.readAt === null).length)
  }

  marcarTodasLeidas(userId: string, ahora: Date): Promise<number> {
    const pendientes = this.visiblesDe(userId).filter((n) => n.readAt === null)
    for (const fila of pendientes) fila.readAt = ahora
    return Promise.resolve(pendientes.length)
  }

  /**
   * Del usuario y de un evento donde es miembro ACTIVO (cualquier tipo) o, sólo
   * para `event.vendor.booked`, proveedor BOOKED de un evento publicado.
   */
  private visiblesDe(userId: string): NotificacionEnMemoria[] {
    return this.filas.filter(
      (n) =>
        n.userId === userId &&
        ((this.miembros.get(n.eventId) ?? []).includes(userId) ||
          (n.type === TIPO_PROVEEDOR_CONTRATADO &&
            this.publicados.has(n.eventId) &&
            (this.proveedores.get(n.eventId) ?? []).includes(userId))),
    )
  }

  private nombreDe(eventId: string): string {
    const name = this.eventos.get(eventId)
    if (name === undefined) throw new Error(`evento ${eventId} sin registrarEvento en el doble`)
    return name
  }

  private delUsuario(eventId: string, userId: string): NotificacionEnMemoria[] {
    return this.filas.filter((n) => n.eventId === eventId && n.userId === userId)
  }
}
