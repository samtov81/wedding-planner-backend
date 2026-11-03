import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'

import { SocketIoRealtimeAdapter } from './socketio-realtime.adapter'

/**
 * Integración contra Redis real: el cierre del adaptador mientras un worker
 * aún emite. Nest llama a `onModuleDestroy` (que cierra esta conexión) ANTES
 * de `onApplicationShutdown`, que es donde `@nestjs/bullmq` cierra los workers
 * y espera a sus jobs activos. Un job en vuelo emite, pues, con la conexión ya
 * cerrándose. El `PUBLISH` del emitter no devuelve promesa: si sale detrás del
 * `QUIT`, ioredis lo rechaza con "Connection is closed" y nadie lo captura.
 * Así falló CI (rechazo no controlado al cerrar `messaging-sala.e2e`).
 */
describe('SocketIoRealtimeAdapter', () => {
  let redis: StartedRedisContainer

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start()
  }, 120_000)

  afterAll(async () => {
    await redis.stop()
  })

  it('emitir durante el cierre rechaza la promesa del job, sin rechazos no controlados', async () => {
    const sueltos: unknown[] = []
    const alRechazo = (motivo: unknown) => sueltos.push(motivo)
    process.on('unhandledRejection', alRechazo)
    try {
      const adaptador = new SocketIoRealtimeAdapter(redis.getConnectionUrl())
      // Conexión lista, como en un worker que ya emitió antes.
      await adaptador.emitirAUsuario('u-1', 'aviso', { n: 1 })

      const cierre = adaptador.onModuleDestroy()
      const emision = adaptador.emitirAUsuario('u-1', 'aviso', { n: 2 })

      await expect(emision).rejects.toThrow()
      await cierre
      // Da una vuelta al bucle para que un rechazo suelto llegue a notificarse.
      await new Promise((resolver) => setTimeout(resolver, 50))
      expect(sueltos).toEqual([])
    } finally {
      process.off('unhandledRejection', alRechazo)
    }
  })

  it('con la conexión abierta emite sin error', async () => {
    const adaptador = new SocketIoRealtimeAdapter(redis.getConnectionUrl())
    await expect(adaptador.emitirAEvento('e-1', 'aviso', {})).resolves.toBeUndefined()
    await adaptador.onModuleDestroy()
  })
})
