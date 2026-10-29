import { TIPO_PROVEEDOR_CONTRATADO, type NotificationPort } from '../application/notification.port'

export interface NotificacionCreada {
  eventId: string
  userId: string
  tipo: string
  payload: unknown
}

/**
 * Doble en memoria del puerto (ruling H1). No es más permisivo que el
 * adaptador real en lo que un test puede observar:
 *  - `crearParaDueno` notifica sólo al dueño REGISTRADO (`registrarDueno`);
 *  - sólo notifica a los miembros REGISTRADOS del evento; un evento sin
 *    miembros registrados no produce ninguna (como uno sin membresías ACTIVAS);
 *  - `avisarAProveedor` crea UNA fila por (`eventId`, `userId`, `eventVendorId`):
 *    llamarlo otra vez reaviva la existente y no añade otra (aquí no hay
 *    `readAt` que reponer, así que simplemente no duplica);
 *  - el `payload` pasa por JSON, como la columna `Json`: un `Date` llega como
 *    texto y un valor no serializable falla aquí igual que fallaría allí.
 */
export class NotificationPortEnMemoria implements NotificationPort {
  readonly creadas: NotificacionCreada[] = []
  private readonly miembros = new Map<string, readonly string[]>()
  private readonly duenos = new Map<string, string>()
  private falloProximo: Error | null = null

  /** Los `userId` con membresía ACTIVA del evento, como los leería el adaptador real. */
  registrarMiembros(eventId: string, userIds: readonly string[]): void {
    this.miembros.set(eventId, [...userIds])
  }

  /** El `Event.ownerId` del evento, como lo leería el adaptador real. */
  registrarDueno(eventId: string, userId: string): void {
    this.duenos.set(eventId, userId)
  }

  /** Hace fallar SÓLO la siguiente creación (p. ej. la base de datos caída). */
  fallarProximaCreacion(error: Error): void {
    this.falloProximo = error
  }

  crearParaMiembros(eventId: string, tipo: string, payload: unknown): Promise<void> {
    return this.crear(eventId, this.miembros.get(eventId) ?? [], tipo, payload)
  }

  /** Una sola fila, para el dueño registrado; un evento sin dueño registrado no crea nada. */
  crearParaDueno(eventId: string, tipo: string, payload: unknown): Promise<void> {
    const dueno = this.duenos.get(eventId)
    return this.crear(eventId, dueno === undefined ? [] : [dueno], tipo, payload)
  }

  /**
   * Honra `fallarProximaCreacion` y serializa el payload como `crear` (ruling B).
   * Una segunda llamada para el mismo `eventVendorId` no añade otra fila.
   */
  async avisarAProveedor(eventId: string, userId: string, eventVendorId: string): Promise<void> {
    const yaAvisado = this.creadas.some(
      (c) =>
        c.eventId === eventId &&
        c.userId === userId &&
        c.tipo === TIPO_PROVEEDOR_CONTRATADO &&
        (c.payload as { eventVendorId?: string }).eventVendorId === eventVendorId,
    )
    // Un fallo armado se consume aunque la fila ya exista: es "la siguiente creación".
    await this.crear(eventId, yaAvisado ? [] : [userId], TIPO_PROVEEDOR_CONTRATADO, {
      eventVendorId,
    })
  }

  /** Borra las filas `event.vendor.booked` de esa contratación y deja el resto. */
  retirarAvisoProveedor(eventId: string, eventVendorId: string): Promise<void> {
    const quedan = this.creadas.filter(
      (c) =>
        !(
          c.eventId === eventId &&
          c.tipo === TIPO_PROVEEDOR_CONTRATADO &&
          (c.payload as { eventVendorId?: string }).eventVendorId === eventVendorId
        ),
    )
    this.creadas.splice(0, this.creadas.length, ...quedan)
    return Promise.resolve()
  }

  private crear(
    eventId: string,
    destinatarios: readonly string[],
    tipo: string,
    payload: unknown,
  ): Promise<void> {
    if (this.falloProximo !== null) {
      const error = this.falloProximo
      this.falloProximo = null
      return Promise.reject(error)
    }

    const serializado = JSON.stringify(payload) as string | undefined
    if (serializado === undefined) {
      return Promise.reject(new Error('payload no serializable a JSON'))
    }

    for (const userId of destinatarios) {
      this.creadas.push({ eventId, userId, tipo, payload: JSON.parse(serializado) as unknown })
    }
    return Promise.resolve()
  }
}
