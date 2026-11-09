import type { OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'

import { GRACIA_MS, TTL_SOCKET_MS, type PresencePort } from '../application/presence.port'

const PREFIJO_SOCKETS = 'presence:sockets:'
const PREFIJO_ANUNCIADO = 'presence:announced:'

/**
 * Registra el socket y renueva la marca; devuelve 1 si la marca NO estaba
 * vigente (no existía o su caducidad ya pasó: hay que anunciar online). En un
 * script porque leer la marca y reescribirla tienen que ir juntos frente a un
 * `confirmarSalida` de otra réplica.
 *
 * KEYS[1] = sockets, KEYS[2] = anunciado; ARGV = socketId, caducidad del
 * socket, TTL del socket, ahora, caducidad de la marca, TTL de la marca (ms).
 */
const CONECTAR = `
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
local marca = redis.call('GET', KEYS[2])
redis.call('SET', KEYS[2], ARGV[5], 'PX', ARGV[6])
if marca and tonumber(marca) > tonumber(ARGV[4]) then return 0 end
return 1
`

/**
 * Latido de UN socket: sólo si sigue registrado (si entretanto se
 * desconectó, renovarlo lo resucitaría como fantasma 75 s y `confirmarSalida`
 * no anunciaría nunca la salida), renueva su caducidad y la de la marca del
 * usuario, ésta sólo si existe (`XX`): el latido mantiene un anuncio, no lo crea.
 *
 * KEYS[1] = sockets, KEYS[2] = anunciado; ARGV = socketId, caducidad del
 * socket, TTL del socket, caducidad de la marca, TTL de la marca (ms).
 */
const RENOVAR = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], ARGV[4], 'XX', 'PX', ARGV[5])
return 1
`

/**
 * Purga los caducados, cuenta los vivos y, si no queda ninguno, borra la marca
 * de anunciado; devuelve 1 si la marca estaba VIGENTE (hay que anunciar
 * offline; una ya caducada se borra sin anunciar). En UN script porque
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
local marca = redis.call('GET', KEYS[2])
redis.call('DEL', KEYS[2])
if marca and tonumber(marca) > tonumber(ARGV[1]) then return 1 end
return 0
`

/**
 * `PresencePort` sobre Redis (spec 2026-11-09 §8, mecánica del builder):
 *
 * - `presence:sockets:<userId>`: ZSET con un miembro por `socketId` y, de
 *   score, su caducidad (`ahora + TTL_SOCKET_MS`). "Vivo" = score > ahora. La
 *   clave entera caduca también (`PEXPIRE`) para que un usuario que no vuelve
 *   no deje basura.
 * - `presence:announced:<userId>`: el usuario está ANUNCIADO en línea mientras
 *   la marca existe y su valor (su caducidad, `ahora + TTL_SOCKET_MS +
 *   gracia`) es > ahora. `conectar` la escribe y anuncia si no estaba vigente;
 *   cada latido la renueva junto al socket; `confirmarSalida` la borra sólo sin
 *   sockets vivos (y anuncia si estaba vigente). La marca, y no el número de
 *   sockets, decide anunciar: así una reconexión dentro de la gracia (la marca
 *   sigue) no anuncia nada.
 *
 * La marca CADUCA a `TTL_SOCKET_MS + gracia` sin latido. Si un proceso muere
 * (o se despliega: el gateway no toca la presencia al cerrar), la marca se
 * queda sin nadie que la borre; sin caducidad, el `conectar` de la vuelta del
 * usuario no anunciaría online y quien cargó el resumen mientras estaba fuera
 * no lo vería volver. Con un socket vivo no caduca nunca: el latido (cada
 * 30 s) la renueva con el socket, y el margen de la gracia por encima del TTL
 * del socket hace que la marca sobreviva siempre al último socket.
 *
 * La caducidad va en el VALOR y se compara con `ahora` (que llega de fuera,
 * como en los sockets), y además en un `PX` real para que la clave no se quede
 * como basura. Comparar con `ahora` mantiene el adaptador y el doble iguales
 * con el reloj del test; el `PX` sólo limpia.
 *
 * Hueco aceptado: si un proceso muere, sus sockets caducan solos a los 75 s y
 * `enLinea` deja de contarlos, pero nadie emite el `presence.changed` offline
 * (no queda proceso con temporizador). Quien mire la sala lo verá en línea
 * hasta que pida el resumen otra vez (`onReconnect` del cliente). Cerrarlo
 * exigiría un barrido periódico de claves; no compensa para un punto verde.
 *
 * Conexión propia de ioredis, como `SocketIoRealtimeAdapter`: no se comparte
 * la del throttler ni la de BullMQ (que es bloqueante) para que el cierre de
 * cada una sea de su dueño.
 */
export class RedisPresenceAdapter implements PresencePort, OnModuleDestroy {
  private readonly redis: Redis
  /** Vida de la marca sin latido: la del socket más la gracia del gateway. */
  private readonly ttlMarcaMs: number

  /** `graciaMs`: la MISMA que inyecta el gateway (`PRESENCIA_GRACIA_MS`). */
  constructor(redisUrl: string, graciaMs: number = GRACIA_MS) {
    this.redis = new Redis(redisUrl)
    this.ttlMarcaMs = TTL_SOCKET_MS + graciaMs
  }

  async conectar(userId: string, socketId: string, ahora: Date): Promise<boolean> {
    const anunciar = await this.redis.eval(
      CONECTAR,
      2,
      claveSockets(userId),
      claveAnunciado(userId),
      socketId,
      ahora.getTime() + TTL_SOCKET_MS,
      TTL_SOCKET_MS,
      ahora.getTime(),
      ahora.getTime() + this.ttlMarcaMs,
      this.ttlMarcaMs,
    )
    return anunciar === 1
  }

  /** Un script por socket (ver `RENOVAR`), todos en una tubería. */
  async renovar(sockets: { userId: string; socketId: string }[], ahora: Date): Promise<void> {
    if (sockets.length === 0) return
    const tuberia = this.redis.pipeline()
    for (const { userId, socketId } of sockets) {
      tuberia.eval(
        RENOVAR,
        2,
        claveSockets(userId),
        claveAnunciado(userId),
        socketId,
        ahora.getTime() + TTL_SOCKET_MS,
        TTL_SOCKET_MS,
        ahora.getTime() + this.ttlMarcaMs,
        this.ttlMarcaMs,
      )
    }
    comprobar(await tuberia.exec())
  }

  async desconectar(userId: string, socketId: string): Promise<void> {
    await this.redis.zrem(claveSockets(userId), socketId)
  }

  async confirmarSalida(userId: string, ahora: Date): Promise<boolean> {
    const anunciar = await this.redis.eval(
      CONFIRMAR_SALIDA,
      2,
      claveSockets(userId),
      claveAnunciado(userId),
      ahora.getTime(),
    )
    return anunciar === 1
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
