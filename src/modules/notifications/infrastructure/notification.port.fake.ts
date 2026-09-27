import type { NotificationPort } from '../application/notification.port'

export interface NotificacionCreada {
  eventId: string
  userId: string
  tipo: string
  payload: unknown
}

/**
 * Doble en memoria del puerto (ruling H1). No es más permisivo que el
 * adaptador real en lo que un test puede observar:
 *  - sólo notifica a los miembros REGISTRADOS del evento; un evento sin
 *    miembros registrados no produce ninguna (como uno sin membresías ACTIVAS);
 *  - el `payload` pasa por JSON, como la columna `Json`: un `Date` llega como
 *    texto y un valor no serializable falla aquí igual que fallaría allí.
 */
export class NotificationPortEnMemoria implements NotificationPort {
  readonly creadas: NotificacionCreada[] = []
  private readonly miembros = new Map<string, readonly string[]>()
  private falloProximo: Error | null = null

  /** Los `userId` con membresía ACTIVA del evento, como los leería el adaptador real. */
  registrarMiembros(eventId: string, userIds: readonly string[]): void {
    this.miembros.set(eventId, [...userIds])
  }

  /** Hace fallar SÓLO la siguiente creación (p. ej. la base de datos caída). */
  fallarProximaCreacion(error: Error): void {
    this.falloProximo = error
  }

  crearParaMiembros(eventId: string, tipo: string, payload: unknown): Promise<void> {
    if (this.falloProximo !== null) {
      const error = this.falloProximo
      this.falloProximo = null
      return Promise.reject(error)
    }

    const serializado = JSON.stringify(payload) as string | undefined
    if (serializado === undefined) {
      return Promise.reject(new Error('payload no serializable a JSON'))
    }

    for (const userId of this.miembros.get(eventId) ?? []) {
      this.creadas.push({ eventId, userId, tipo, payload: JSON.parse(serializado) as unknown })
    }
    return Promise.resolve()
  }
}
