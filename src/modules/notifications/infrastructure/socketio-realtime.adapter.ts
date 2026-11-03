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
 *
 * Cierre. Nest llama a `onModuleDestroy` (que cierra esta conexión) ANTES de
 * `onApplicationShutdown`, que es donde `@nestjs/bullmq` cierra los workers y
 * espera a sus jobs activos: un job en vuelo puede emitir con el `QUIT` ya
 * enviado. Ese `PUBLISH` sale detrás del `QUIT`, ioredis lo rechaza con
 * "Connection is closed" y, como el emitter descarta la promesa, el rechazo
 * queda suelto (así cayó CI al cerrar `messaging-sala.e2e`). Por eso, desde que
 * empieza el cierre, `emitir` rechaza SU promesa: el job falla de forma
 * controlada y BullMQ lo reintenta al volver. Lo publicado antes del `QUIT`
 * sale antes que él y no se pierde. Alternativa descartada: cerrar la conexión
 * en `onApplicationShutdown`; Nest no garantiza el orden de ese hook entre
 * módulos, así que no asegura que los workers hayan terminado antes.
 */
export class SocketIoRealtimeAdapter implements RealtimePort, OnModuleDestroy {
  private readonly redis: Redis
  private readonly emisor: Emitter
  private cerrando = false

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
    this.cerrando = true
    await this.redis.quit()
  }

  private async emitir(sala: string, tipo: string, payload: unknown): Promise<void> {
    if (this.cerrando) throw new Error('RealtimePort cerrándose: no se emite')
    if (this.redis.status !== 'ready') {
      // Recién construido puede estar aún conectando: se le da una oportunidad.
      await this.redis.ping()
    }
    this.emisor.to(sala).emit(tipo, payload)
  }
}
