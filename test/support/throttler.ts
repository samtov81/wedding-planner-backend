import { Redis } from 'ioredis'

/**
 * Borra los contadores de ritmo de `@nest-lab/throttler-storage-redis` para que
 * un test no herede un límite agotado por otro. Sólo toca las claves del
 * throttler, nunca las de BullMQ.
 *
 * El patrón NO es `*throttler*`: la librería no mete esa palabra en la clave.
 * `ThrottlerStorageRedisService.increment` construye `{${key}:${throttlerName}}:hits`
 * y `{${key}:${throttlerName}}:blocked`, con `key` un sha256 hex generado por
 * `ThrottlerGuard.generateKey` — comprobado contra el contenedor real de test
 * (`KEYS *` tras una petición): `{ed0e...ba7e8ef:global}:hits`. BullMQ usa
 * claves `bull:<cola>:...`, sin llaves, así que `{*}:*` distingue ambas sin
 * ambigüedad: es el único productor en este código que envuelve la clave entre
 * `{` y `}` (hash tag de Redis Cluster que exige la propia librería).
 */
export async function limpiarContadoresDeRitmo(redisUrl: string): Promise<void> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 })
  try {
    let cursor = '0'
    do {
      const [siguiente, claves] = await redis.scan(cursor, 'MATCH', '{*}:*', 'COUNT', 500)
      if (claves.length > 0) await redis.del(...claves)
      cursor = siguiente
    } while (cursor !== '0')
  } finally {
    redis.disconnect()
  }
}
