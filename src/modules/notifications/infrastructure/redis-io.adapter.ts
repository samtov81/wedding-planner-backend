import { once } from 'node:events'

import type { INestApplicationContext } from '@nestjs/common'
import { IoAdapter } from '@nestjs/platform-socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import Redis from 'ioredis'
import type { Server, ServerOptions } from 'socket.io'

/**
 * Adapter de Socket.IO sobre Redis para el servidor HTTP.
 *
 * Sin él, un usuario conectado a la instancia B nunca recibe lo que emite la
 * instancia A. Y quien emite aquí es el WORKER, que puede ser otro proceso
 * distinto del HTTP: sin Redis, el fan-out no sale de su propio proceso (ver
 * `SocketIoRealtimeAdapter`, que publica en el canal que esto escucha).
 *
 * DESIGN-GAP (brief, Paso 4): el brief usa `createClient` del paquete `redis`.
 * Aquí se usa `ioredis`, que ya es dependencia (BullMQ, throttler) y que
 * `@socket.io/redis-adapter` soporta igual: una segunda librería cliente de
 * Redis no aporta nada.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly clientes: Redis[] = []
  private fabrica: ReturnType<typeof createAdapter> | null = null

  constructor(app: INestApplicationContext) {
    super(app)
  }

  /** Abre las dos conexiones (pub y sub). Llamar ANTES de `useWebSocketAdapter`. */
  async conectar(redisUrl: string): Promise<void> {
    const pub = new Redis(redisUrl)
    const sub = pub.duplicate()
    this.clientes.push(pub, sub)
    await Promise.all([once(pub, 'ready'), once(sub, 'ready')])
    this.fabrica = createAdapter(pub, sub)
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    if (this.fabrica === null) throw new Error('RedisIoAdapter: llama a conectar() antes de usarlo')
    const servidor = super.createIOServer(port, options) as Server
    servidor.adapter(this.fabrica)
    return servidor
  }

  override async dispose(): Promise<void> {
    await super.dispose()
    await Promise.all(this.clientes.map((c) => c.quit()))
  }
}
