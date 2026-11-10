import { RedisPresenceAdapter } from './redis-presence.adapter'

/**
 * Sin contenedor a propósito: lo que se prueba es qué hace el adaptador
 * cuando NO hay Redis. El puerto 1 de loopback rechaza la conexión al
 * instante, así que el tiempo medido es sólo el de los reintentos de ioredis.
 * El adaptador no escucha `error` (ioredis lo escribe con `console.error`):
 * se silencia aquí para que la salida del test quede limpia.
 */
describe('RedisPresenceAdapter con Redis caído', () => {
  it('enLinea falla en menos de 2 s en vez de esperar a reconectar', async () => {
    const consola = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const presencia = new RedisPresenceAdapter('redis://127.0.0.1:1')
    const inicio = Date.now()
    await expect(presencia.enLinea(['u1'], new Date())).rejects.toThrow()
    expect(Date.now() - inicio).toBeLessThan(2_000)
    await presencia.onModuleDestroy().catch(() => undefined)
    consola.mockRestore()
  })
})
