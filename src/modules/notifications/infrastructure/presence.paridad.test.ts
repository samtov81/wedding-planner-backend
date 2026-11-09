import { randomUUID } from 'node:crypto'

import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'

import { TTL_SOCKET_MS, type PresencePort } from '../application/presence.port'
import { PresenceEnMemoria } from './presence.fake'
import { RedisPresenceAdapter } from './redis-presence.adapter'

const T0 = new Date('2026-11-09T12:00:00.000Z')

/** `T0` más `ms`: el reloj lo mueve el test, nadie duerme. */
function en(ms: number): Date {
  return new Date(T0.getTime() + ms)
}

/**
 * Ruling H1: el gateway y los casos de uso se prueban contra el doble, así que
 * el doble tiene que contestar lo MISMO que Redis. Cada caso se escribe una vez
 * y corre contra los dos; los usuarios son nuevos en cada caso para que el
 * Redis compartido no arrastre estado de un caso a otro.
 */
describe('Paridad: PresenceEnMemoria vs RedisPresenceAdapter', () => {
  let redis: StartedRedisContainer
  let real: RedisPresenceAdapter

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start()
    real = new RedisPresenceAdapter(redis.getConnectionUrl())
  }, 120_000)

  afterAll(async () => {
    await real.onModuleDestroy()
    await redis.stop()
  })

  function implementaciones(): Array<[string, PresencePort]> {
    return [
      ['Redis', real],
      ['doble', new PresenceEnMemoria()],
    ]
  }

  it('la primera conexión anuncia online; la segunda del mismo usuario, no', async () => {
    for (const [nombre, presencia] of implementaciones()) {
      const userId = randomUUID()

      expect(await presencia.conectar(userId, 's1', T0), nombre).toBe(true)
      expect(await presencia.conectar(userId, 's2', T0), nombre).toBe(false)
      expect(await presencia.enLinea([userId], T0), nombre).toEqual(new Set([userId]))
    }
  })

  it('desconectar uno de dos sockets no anuncia offline', async () => {
    for (const [nombre, presencia] of implementaciones()) {
      const userId = randomUUID()
      await presencia.conectar(userId, 's1', T0)
      await presencia.conectar(userId, 's2', T0)

      await presencia.desconectar(userId, 's1')

      expect(await presencia.confirmarSalida(userId, en(1_000)), nombre).toBe(false)
      expect(await presencia.enLinea([userId], en(1_000)), nombre).toEqual(new Set([userId]))
    }
  })

  it('desconectar el último anuncia offline una sola vez y deja de contar en enLinea', async () => {
    for (const [nombre, presencia] of implementaciones()) {
      const userId = randomUUID()
      await presencia.conectar(userId, 's1', T0)

      await presencia.desconectar(userId, 's1')

      expect(await presencia.confirmarSalida(userId, en(1_000)), nombre).toBe(true)
      // Dos temporizadores de gracia del mismo usuario: sólo uno anuncia.
      expect(await presencia.confirmarSalida(userId, en(1_000)), nombre).toBe(false)
      expect(await presencia.enLinea([userId], en(1_000)), nombre).toEqual(new Set())
      // Y vuelve a anunciarse online al reconectar.
      expect(await presencia.conectar(userId, 's2', en(2_000)), nombre).toBe(true)
    }
  })

  it('reconectar dentro de la gracia no anuncia ni offline ni online', async () => {
    // Review Focus 4: la renovación del token cada 15 min echa el socket y el
    // cliente vuelve con otro. Ni la sala ni nadie debe ver el parpadeo.
    for (const [nombre, presencia] of implementaciones()) {
      const userId = randomUUID()
      await presencia.conectar(userId, 's1', T0)

      await presencia.desconectar(userId, 's1')
      expect(await presencia.conectar(userId, 's2', en(500)), nombre).toBe(false)

      expect(await presencia.confirmarSalida(userId, en(20_000)), nombre).toBe(false)
      expect(await presencia.enLinea([userId], en(20_000)), nombre).toEqual(new Set([userId]))
    }
  })

  it('un socket sin latido caduca a los 75 s; con latido sigue vivo', async () => {
    for (const [nombre, presencia] of implementaciones()) {
      const sinLatido = randomUUID()
      const conLatido = randomUUID()
      await presencia.conectar(sinLatido, 's1', T0)
      await presencia.conectar(conLatido, 's2', T0)

      await presencia.renovar([{ userId: conLatido, socketId: 's2' }], en(30_000))

      expect(await presencia.enLinea([sinLatido, conLatido], en(76_000)), nombre).toEqual(
        new Set([conLatido]),
      )
      // Justo en el borde todavía cuenta: "vivo" es caducidad > ahora.
      expect(await presencia.enLinea([sinLatido], en(TTL_SOCKET_MS - 1)), nombre).toEqual(
        new Set([sinLatido]),
      )
    }
  })

  it('el proceso que murió deja sus sockets caducados: confirmarSalida los purga y anuncia', async () => {
    // Nadie llamó a `desconectar` (el proceso cayó). El siguiente
    // `confirmarSalida` del usuario, tras la caducidad, sí puede anunciar.
    for (const [nombre, presencia] of implementaciones()) {
      const userId = randomUUID()
      await presencia.conectar(userId, 'huerfano', T0)

      expect(await presencia.confirmarSalida(userId, en(10_000)), nombre).toBe(false)
      expect(await presencia.confirmarSalida(userId, en(76_000)), nombre).toBe(true)
    }
  })

  it('renovar no resucita un socket ya desconectado', async () => {
    // El latido toma la lista de sockets del proceso y la manda a Redis; si
    // entretanto uno se desconecta, renovarlo lo dejaría como fantasma 75 s.
    for (const [nombre, presencia] of implementaciones()) {
      const userId = randomUUID()
      await presencia.conectar(userId, 's1', T0)
      await presencia.desconectar(userId, 's1')

      await presencia.renovar([{ userId, socketId: 's1' }], en(1_000))

      expect(await presencia.enLinea([userId], en(1_000)), nombre).toEqual(new Set())
      expect(await presencia.confirmarSalida(userId, en(1_000)), nombre).toBe(true)
    }
  })

  it('enLinea con varios usuarios devuelve sólo los conectados, y con ninguno, vacío', async () => {
    for (const [nombre, presencia] of implementaciones()) {
      const a = randomUUID()
      const b = randomUUID()
      const nunca = randomUUID()
      await presencia.conectar(a, 's1', T0)
      await presencia.conectar(b, 's2', T0)
      await presencia.desconectar(b, 's2')

      expect(await presencia.enLinea([a, b, nunca], T0), nombre).toEqual(new Set([a]))
      expect(await presencia.enLinea([], T0), nombre).toEqual(new Set())
      await presencia.renovar([], T0)
    }
  })
})
