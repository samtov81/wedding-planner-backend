import type { RealtimePort } from '../application/realtime.port'

export interface EmisionRegistrada {
  destino: { eventId: string } | { userId: string }
  tipo: string
  payload: unknown
}

/**
 * Doble en memoria del puerto (ruling H1): registra lo emitido y permite
 * simular que el fan-out falla (Redis caído), que es el caso que el diseño de
 * tiempo real tiene que aguantar sin perder nada.
 */
export class RealtimePortEnMemoria implements RealtimePort {
  readonly emitidas: EmisionRegistrada[] = []
  private falloProximo: Error | null = null

  /** Hace fallar SÓLO la siguiente emisión. */
  fallarProximaEmision(error: Error): void {
    this.falloProximo = error
  }

  emitirAEvento(eventId: string, tipo: string, payload: unknown): Promise<void> {
    return this.registrar({ eventId }, tipo, payload)
  }

  emitirAUsuario(userId: string, tipo: string, payload: unknown): Promise<void> {
    return this.registrar({ userId }, tipo, payload)
  }

  private registrar(
    destino: EmisionRegistrada['destino'],
    tipo: string,
    payload: unknown,
  ): Promise<void> {
    if (this.falloProximo !== null) {
      const error = this.falloProximo
      this.falloProximo = null
      return Promise.reject(error)
    }
    this.emitidas.push({ destino, tipo, payload })
    return Promise.resolve()
  }
}
