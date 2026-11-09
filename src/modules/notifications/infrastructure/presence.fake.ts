import { TTL_SOCKET_MS, type PresencePort } from '../application/presence.port'

/**
 * Doble en memoria de `PresencePort` (ruling H1), con la MISMA mecánica que
 * `RedisPresenceAdapter`: por usuario, un mapa socket → caducidad y una marca
 * de "anunciado". `presence.paridad.test.ts` comprueba que contestan igual.
 *
 * `fallar` hace rechazar todas las operaciones (Redis caído): es el caso que
 * el gateway tiene que aguantar sin romper la conexión del socket.
 */
export class PresenceEnMemoria implements PresencePort {
  private readonly sockets = new Map<string, Map<string, number>>()
  private readonly anunciados = new Set<string>()
  fallar: Error | null = null

  conectar(userId: string, socketId: string, ahora: Date): Promise<boolean> {
    return this.operar(() => {
      this.socketsDe(userId).set(socketId, ahora.getTime() + TTL_SOCKET_MS)
      if (this.anunciados.has(userId)) return false
      this.anunciados.add(userId)
      return true
    })
  }

  renovar(sockets: { userId: string; socketId: string }[], ahora: Date): Promise<void> {
    return this.operar(() => {
      for (const { userId, socketId } of sockets) {
        const deUsuario = this.sockets.get(userId)
        // Como `ZADD XX`: sólo renueva lo que sigue registrado.
        if (deUsuario?.has(socketId) === true) {
          deUsuario.set(socketId, ahora.getTime() + TTL_SOCKET_MS)
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
      return this.anunciados.delete(userId)
    })
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
