import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { limpiarContadoresDeRitmo } from '../support/throttler'

describe('Salud e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let postgresParado = false

  /**
   * Para el Postgres de TESTCONTAINERS de este fichero (el de `startPostgres`),
   * nunca nada del host. Idempotente: `afterAll` no puede pararlo dos veces.
   */
  async function pararPostgres(): Promise<void> {
    if (postgresParado) return
    postgresParado = true
    await pg.stop()
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
  }, 240_000)

  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
  })

  afterAll(async () => {
    await cerrar()
    await redis.stop()
    await pararPostgres()
  }, 60_000)

  it('/health responde 200 con el proceso vivo', async () => {
    const respuesta = await request(url).get('/health').expect(200)

    expect(respuesta.body).toEqual({ status: 'ok' })
  })

  it('/health/ready responde 200 con la base de datos y Redis arriba', async () => {
    const respuesta = await request(url).get('/health/ready').expect(200)

    expect(respuesta.body).toEqual({ status: 'ok', checks: { db: true, redis: true } })
  })

  it('el límite de ritmo NO cae sobre las sondas: un 429 en liveness mata el pod', async () => {
    // Las sondas del orquestador llegan siempre desde la misma IP y a ritmo
    // fijo. Con el `global` de 120/min, la sonda 121 sería un 429 y el
    // orquestador daría el proceso por muerto.
    const primera = await request(url).get('/health').expect(200)
    expect(primera.headers['x-ratelimit-limit-global']).toBeUndefined()

    // El `global` cuenta por IP Y por ruta: hay que pasar de 120 en UNA ruta.
    for (const ruta of ['/health', '/health/ready']) {
      for (let i = 0; i < 125; i += 1) await request(url).get(ruta).expect(200)
    }
  })

  describe('con la base de datos caída', () => {
    it('/health/ready falla si la base de datos no responde', async () => {
      await pararPostgres()

      const respuesta = await request(url).get('/health/ready').expect(503)

      expect(respuesta.text).toContain('"db":false')
      expect(respuesta.text).toContain('"redis":true')
    })

    it('/health responde aunque la base de datos esté caída', async () => {
      // Liveness y readiness son preguntas distintas: confundirlas hace que el
      // orquestador MATE el proceso durante un incidente de base de datos, que
      // es exactamente cuando no quieres reiniciarlo todo.
      await pararPostgres()

      await request(url).get('/health').expect(200)
    })
  })
})
