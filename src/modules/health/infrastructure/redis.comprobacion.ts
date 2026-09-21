import type { OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'

import { aTiempo, type Comprobacion } from '../application/comprobacion.port'

/**
 * Conexión propia y mínima: la de BullMQ o la del limitador no se exponen como
 * puerto, y un `PING` no justifica abrirlas.
 *
 * `enableOfflineQueue: false`: con Redis caído, ioredis por defecto ENCOLA el
 * comando hasta reconectar, y la sonda esperaría en vez de fallar.
 */
export class RedisComprobacion implements Comprobacion, OnModuleDestroy {
  readonly nombre = 'redis'
  private readonly cliente: Redis

  constructor(redisUrl: string) {
    this.cliente = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
    // Sin oyente, un Redis caído sería un `error` no manejado que tumba el
    // proceso; aquí sólo tiene que volver `false` en la próxima sonda.
    this.cliente.on('error', () => undefined)
  }

  async comprobar(): Promise<boolean> {
    return await aTiempo(this.cliente.ping())
  }

  onModuleDestroy(): void {
    this.cliente.disconnect()
  }
}
