import { GRACIA_MS, TTL_SOCKET_MS, type PresencePort } from '../application/presence.port'

/**
 * Doble en memoria de `PresencePort` (ruling H1), con la MISMA mecánica que
 * `RedisPresenceAdapter`: por usuario, un mapa socket → caducidad y una marca
 * de "anunciado" con su caducidad (`TTL_SOCKET_MS + gracia`, renovada por el
 * latido). `presence.paridad.test.ts` comprueba que contestan igual.
 *
 * `fallar` hace rechazar todas las operaciones (Redis caído): es el caso que
 * el gateway tiene que aguantar sin romper la conexión del socket.
 */
export class PresenceEnMemoria implements PresencePort {
  private readonly sockets = new Map<string, Map<string, number>>()
  /** userId → caducidad de su marca de anunciado (ms). */
  private readonly anunciados = new Map<string, number>()
  private readonly ttlMarcaMs: number
  fallar: Error | null = null

  constructor(graciaMs: number = GRACIA_MS) {
    this.ttlMarcaMs = TTL_SOCKET_MS + graciaMs
  }

  conectar(userId: string, socketId: string, ahora: Date): Promise<boolean> {
    return this.operar(() => {
      this.socketsDe(userId).set(socketId, ahora.getTime() + TTL_SOCKET_MS)
      const vigente = this.vigente(userId, ahora)
      this.anunciados.set(userId, ahora.getTime() + this.ttlMarcaMs)
      return !vigente
    })
  }

  renovar(sockets: { userId: string; socketId: string }[], ahora: Date): Promise<void> {
    return this.operar(() => {
      for (const { userId, socketId } of sockets) {
        const deUsuario = this.sockets.get(userId)
        // Como `ZADD XX`: sólo renueva lo que sigue registrado.
        if (deUsuario?.has(socketId) === true) {
          deUsuario.set(socketId, ahora.getTime() + TTL_SOCKET_MS)
          // Como `SET XX`: renueva la marca sólo si existe; el latido no la crea.
          if (this.anunciados.has(userId)) {
            this.anunciados.set(userId, ahora.getTime() + this.ttlMarcaMs)
          }
        }
      }
    })
  }

  desconectar(userId: string, socketId: string): Promise<void> {
    return this.operar(() => {
      this.sockets.get(userId)?.delete(socketId)
    })
  }

  confirmarSalida(userId: string, ahora: Date): Promise<boolean> {
    return this.operar(() => {
      // Purga los caducados, como `ZREMRANGEBYSCORE`, y luego cuenta (`ZCARD`).
      const deUsuario = this.sockets.get(userId)
      for (const [socketId, caduca] of deUsuario ?? []) {
        if (caduca <= ahora.getTime()) deUsuario?.delete(socketId)
      }
      if ((deUsuario?.size ?? 0) > 0) return false
      // Una marca ya caducada se borra sin anunciar: nadie la tenía por vigente.
      const vigente = this.vigente(userId, ahora)
      this.anunciados.delete(userId)
      return vigente
    })
  }

  private vigente(userId: string, ahora: Date): boolean {
    return (this.anunciados.get(userId) ?? -Infinity) > ahora.getTime()
  }

  /** Sólo cuenta, sin purgar: como `ZCOUNT`, una lectura no cambia el estado. */
  enLinea(userIds: string[], ahora: Date): Promise<Set<string>> {
    return this.operar(
      () =>
        new Set(
          userIds.filter((id) =>
            [...(this.sockets.get(id)?.values() ?? [])].some((caduca) => caduca > ahora.getTime()),
          ),
        ),
    )
  }

  private socketsDe(userId: string): Map<string, number> {
    let deUsuario = this.sockets.get(userId)
    if (deUsuario === undefined) {
      deUsuario = new Map()
      this.sockets.set(userId, deUsuario)
    }
    return deUsuario
  }

  private operar<T>(accion: () => T): Promise<T> {
    if (this.fallar !== null) return Promise.reject(this.fallar)
    return Promise.resolve(accion())
  }
}
