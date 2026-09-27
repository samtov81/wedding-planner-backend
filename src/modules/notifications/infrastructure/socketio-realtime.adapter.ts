import type { OnModuleDestroy } from '@nestjs/common'
import { Emitter } from '@socket.io/redis-emitter'
import Redis from 'ioredis'

import type { RealtimePort } from '../application/realtime.port'
import { NAMESPACE_REALTIME, salaDeEvento, salaDeUsuario } from '../application/salas'

/**
 * `RealtimePort` sobre Socket.IO, publicando en Redis con
 * `@socket.io/redis-emitter`.
 *
 * DESIGN-GAP (brief, "Produces"): el brief nombra `socketio-realtime.adapter`
 * sin decir cómo llega a los sockets. Quien emite es el WORKER (ruling C23), y
 * el worker no tiene por qué tener un servidor de Socket.IO: puede ser otro
 * proceso. El emitter publica en el mismo canal que escucha
 * `@socket.io/redis-adapter` en cada servidor HTTP (ver `RedisIoAdapter`), así
 * que el aviso llega a los sockets de TODAS las instancias, esté el worker
 * donde esté. Por eso se añade la dependencia `@socket.io/redis-emitter`.
 *
 * Fallo visible: el emitter no devuelve la promesa del `PUBLISH` (la
 * descarta). Por eso, si la conexión no está lista, antes de emitir se hace un
 * `PING` que SÍ se espera: si Redis vuelve, se emite; si no, ioredis lo
 * rechaza al agotar sus reintentos, el job falla y BullMQ lo reintenta. Con la
 * conexión lista, un `PUBLISH` que falle justo después se pierde sin aviso: lo
 * que se pierde es latencia, porque la `Notification` ya está en Postgres.
 */
export class SocketIoRealtimeAdapter implements RealtimePort, OnModuleDestroy {
  private readonly redis: Redis
  private readonly emisor: Emitter

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl)
    this.emisor = new Emitter(this.redis).of(NAMESPACE_REALTIME)
  }

  emitirAEvento(eventId: string, tipo: string, payload: unknown): Promise<void> {
    return this.emitir(salaDeEvento(eventId), tipo, payload)
  }

  emitirAUsuario(userId: string, tipo: string, payload: unknown): Promise<void> {
    return this.emitir(salaDeUsuario(userId), tipo, payload)
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit()
  }

  private async emitir(sala: string, tipo: string, payload: unknown): Promise<void> {
    if (this.redis.status !== 'ready') {
      // Recién construido puede estar aún conectando: se le da una oportunidad.
      await this.redis.ping()
    }
    this.emisor.to(sala).emit(tipo, payload)
  }
}
