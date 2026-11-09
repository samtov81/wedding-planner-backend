import type { OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'

import { TTL_SOCKET_MS, type PresencePort } from '../application/presence.port'

const PREFIJO_SOCKETS = 'presence:sockets:'
const PREFIJO_ANUNCIADO = 'presence:announced:'

/**
 * Purga los caducados, cuenta los vivos y, si no queda ninguno, borra la marca
 * de anunciado; devuelve cuántas claves borró (0 o 1). En UN script porque
 * tiene que ser atómico frente a un `conectar` de otra réplica: entre un
 * `ZCARD = 0` y el `DEL` sueltos, un socket nuevo del mismo usuario entraría
 * sin anunciarse (la marca aún existía) y el `DEL` lo anunciaría offline
 * estando conectado. Dentro del script, `conectar` va entero antes (hay un
 * socket: no se borra) o entero después (la marca ya no está: anuncia online).
 *
 * KEYS[1] = sockets, KEYS[2] = anunciado; ARGV[1] = ahora en ms.
 */
const CONFIRMAR_SALIDA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) > 0 then return 0 end
return redis.call('DEL', KEYS[2])
`

/**
 * `PresencePort` sobre Redis (spec 2026-11-09 §8, mecánica del builder):
 *
 * - `presence:sockets:<userId>`: ZSET con un miembro por `socketId` y, de
 *   score, su caducidad (`ahora + TTL_SOCKET_MS`). "Vivo" = score > ahora. La
 *   clave entera caduca también (`PEXPIRE`) para que un usuario que no vuelve
 *   no deje basura.
 * - `presence:announced:<userId>`: existe mientras el usuario está ANUNCIADO
 *   en línea. `conectar` la crea con `SET NX` (y anuncia si la creó);
 *   `confirmarSalida` la borra sólo sin sockets vivos (y anuncia si la borró).
 *   La marca, y no el número de sockets, es lo que decide anunciar: así una
 *   reconexión dentro de la gracia (la marca sigue) no anuncia nada.
 *
 * Hueco aceptado: si un proceso muere, sus sockets caducan solos a los 75 s y
 * `enLinea` deja de contarlos, pero nadie emite el `presence.changed` offline
 * (no queda proceso con temporizador). La marca sigue hasta el próximo
 * `confirmarSalida` del usuario. Quien mire la sala lo verá en línea hasta
 * que pida el resumen otra vez (`onReconnect` del cliente). Cerrarlo exigiría
 * un barrido periódico de claves; no compensa para un punto verde.
 *
 * La marca NO caduca: si caducara con el usuario aún conectado, su
 * `confirmarSalida` no encontraría nada que borrar y nunca anunciaría offline.
 *
 * Conexión propia de ioredis, como `SocketIoRealtimeAdapter`: no se comparte
 * la del throttler ni la de BullMQ (que es bloqueante) para que el cierre de
 * cada una sea de su dueño.
 */
export class RedisPresenceAdapter implements PresencePort, OnModuleDestroy {
  private readonly redis: Redis

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl)
  }

  async conectar(userId: string, socketId: string, ahora: Date): Promise<boolean> {
    const resultados = await this.redis
      .multi()
      .zadd(claveSockets(userId), ahora.getTime() + TTL_SOCKET_MS, socketId)
      .pexpire(claveSockets(userId), TTL_SOCKET_MS)
      .set(claveAnunciado(userId), '1', 'NX')
      .exec()
    // `SET NX` responde 'OK' si creó la clave y `null` si ya existía.
    const [, , creada] = comprobar(resultados)
    return creada === 'OK'
  }

  /**
   * `ZADD XX`: sólo renueva sockets que SIGUEN registrados. El latido toma la
   * lista de sockets del proceso y la manda después; si entretanto uno se
   * desconectó, un `ZADD` normal lo resucitaría y dejaría un fantasma 75 s que,
   * además, haría que `confirmarSalida` no anunciara nunca la salida.
   */
  async renovar(sockets: { userId: string; socketId: string }[], ahora: Date): Promise<void> {
    if (sockets.length === 0) return
    const tuberia = this.redis.pipeline()
    for (const { userId, socketId } of sockets) {
      tuberia.zadd(claveSockets(userId), 'XX', ahora.getTime() + TTL_SOCKET_MS, socketId)
      tuberia.pexpire(claveSockets(userId), TTL_SOCKET_MS)
    }
    comprobar(await tuberia.exec())
  }

  async desconectar(userId: string, socketId: string): Promise<void> {
    await this.redis.zrem(claveSockets(userId), socketId)
  }

  async confirmarSalida(userId: string, ahora: Date): Promise<boolean> {
    const borradas = await this.redis.eval(
      CONFIRMAR_SALIDA,
      2,
      claveSockets(userId),
      claveAnunciado(userId),
      ahora.getTime(),
    )
    return borradas === 1
  }

  /** `ZCOUNT (ahora +inf`: cuenta sin purgar; una lectura no cambia el estado. */
  async enLinea(userIds: string[], ahora: Date): Promise<Set<string>> {
    if (userIds.length === 0) return new Set()
    const tuberia = this.redis.pipeline()
    for (const userId of userIds)
      tuberia.zcount(claveSockets(userId), `(${ahora.getTime()}`, '+inf')
    const resultados = comprobar(await tuberia.exec())
    const vivos = resultados.map((n) => Number(n) > 0)
    return new Set(userIds.filter((_, i) => vivos.at(i) === true))
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit()
  }
}

function claveSockets(userId: string): string {
  return `${PREFIJO_SOCKETS}${userId}`
}

function claveAnunciado(userId: string): string {
  return `${PREFIJO_ANUNCIADO}${userId}`
}

type ResultadosDeLote = [error: Error | null, resultado: unknown][] | null

/**
 * `exec` no rechaza si falla un comando del lote: deja el error en su tupla.
 * Sin esto, un fallo de Redis se leería como "nadie en línea".
 */
function comprobar(resultados: ResultadosDeLote): unknown[] {
  if (resultados === null) throw new Error('Presencia: lote de Redis abortado')
  return resultados.map(([error, resultado]) => {
    if (error !== null) throw error
    return resultado
  })
}
