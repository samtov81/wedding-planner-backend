import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { io } from 'socket.io-client'
import request from 'supertest'

import { generarTokenInvitacion } from '@/modules/guests/domain/invitation'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { limpiarContadoresDeRitmo } from '../support/throttler'

const FRONTEND = 'http://localhost:5173'
const ADMIN = 'https://admin.example.test'
const MALICIOSO = 'https://sitio-malicioso.test'

describe('endurecimiento del arranque', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  const otrosCierres: Array<() => Promise<void>> = []

  function tokenInventado(): string {
    return generarTokenInvitacion().token
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno(
      { databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() },
      { CORS_ORIGINS: ADMIN },
    )
    // Escuchando de verdad: el cliente de Socket.IO necesita un puerto.
    ;({ url, cerrar } = await arrancarAppDeTest())
  }, 240_000)

  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
  })

  afterAll(async () => {
    delete process.env.CORS_ORIGINS
    delete process.env.TRUST_PROXY
    for (const cerrarOtra of otrosCierres) await cerrarOtra()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  describe('cabeceras', () => {
    it('no revela el servidor en las cabeceras', async () => {
      const { headers } = await request(url).get('/health').expect(200)

      expect(headers['x-powered-by']).toBeUndefined()
      expect(headers['x-content-type-options']).toBe('nosniff')
    })

    it('Swagger UI se sirve y, fuera de producción, la CSP no fuerza https', async () => {
      // Con `upgrade-insecure-requests` en `http://localhost`, el navegador
      // pediría por https los scripts de Swagger UI y la página saldría vacía.
      const { headers } = await request(url).get('/docs').expect(200)

      expect(headers['content-security-policy']).toContain("script-src 'self'")
      expect(headers['content-security-policy']).not.toContain('upgrade-insecure-requests')
    })

    it('propaga el x-request-id entrante', async () => {
      const { headers } = await request(url).get('/health').set('x-request-id', 'trazable-1')

      expect(headers['x-request-id']).toBe('trazable-1')
    })

    it.each([
      ['demasiado largo', 'a'.repeat(300)],
      ['con caracteres fuera de [A-Za-z0-9._:-]', 'id {"level":60,"msg":"falso"}'],
    ])('un x-request-id %s se sustituye por uno propio', async (_caso, raro) => {
      // Se escribe tal cual en cada línea de log y en el cuerpo de los errores:
      // sin acotarlo, un cliente mete megas de texto o JSON falso en los logs.
      const { headers } = await request(url).get('/health').set('x-request-id', raro)

      expect(headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    })
  })

  describe('CORS del HTTP', () => {
    it('rechaza un origen que no está en la allowlist', async () => {
      const { headers } = await request(url).get('/health').set('Origin', MALICIOSO)

      expect(headers['access-control-allow-origin']).toBeUndefined()
    })

    it.each([FRONTEND, ADMIN])('acepta %s, con credenciales (la cookie del refresh)', async (o) => {
      const { headers } = await request(url).get('/health').set('Origin', o)

      expect(headers['access-control-allow-origin']).toBe(o)
      expect(headers['access-control-allow-credentials']).toBe('true')
    })

    it('el preflight de un origen ajeno no autoriza nada', async () => {
      const { headers } = await request(url)
        .options('/auth/login')
        .set('Origin', MALICIOSO)
        .set('Access-Control-Request-Method', 'POST')

      expect(headers['access-control-allow-origin']).toBeUndefined()
    })
  })

  describe('CORS de Socket.IO: la MISMA allowlist que el HTTP', () => {
    const handshake = '/socket.io/?EIO=4&transport=polling'

    it('el handshake desde el frontend lleva la cabecera CORS', async () => {
      const { headers } = await request(url).get(handshake).set('Origin', FRONTEND).expect(200)

      expect(headers['access-control-allow-origin']).toBe(FRONTEND)
    })

    it('el handshake desde un origen ajeno se rechaza', async () => {
      const { headers } = await request(url).get(handshake).set('Origin', MALICIOSO).expect(403)

      expect(headers['access-control-allow-origin']).toBeUndefined()
    })

    /**
     * El WebSocket no pasa por CORS: el navegador abre la conexión desde
     * cualquier página y sólo manda `Origin`. Sin comprobarlo en el servidor,
     * la allowlist sólo cubriría el long-polling.
     */
    async function motivoDelRechazo(origen: string): Promise<string> {
      const socket = io(`${url}/realtime`, {
        transports: ['websocket'],
        extraHeaders: { Origin: origen },
        reconnection: false,
        forceNew: true,
      })
      try {
        return await new Promise<string>((resolve, reject) => {
          socket.once('connect', () => reject(new Error('conectó sin token')))
          socket.once('connect_error', (error) => resolve(error.message))
        })
      } finally {
        socket.close()
      }
    }

    it('un WebSocket desde un origen ajeno se corta ANTES de autenticar', async () => {
      expect(await motivoDelRechazo(MALICIOSO)).toBe('websocket error')
    })

    it('un WebSocket desde el frontend pasa el origen y llega a la autenticación', async () => {
      // Sin token la conexión se rechaza igual, pero en el middleware del
      // namespace: prueba que el origen SÍ se aceptó.
      expect(await motivoDelRechazo(FRONTEND)).toBe('No autorizado')
    })
  })

  describe('límite de cuerpo', () => {
    it('rechaza un cuerpo desmesurado antes de procesarlo', async () => {
      await request(url)
        .post('/auth/register')
        .send({ fullName: 'a'.repeat(2_000_000), email: 'a@b.com', password: 'x'.repeat(12) })
        .expect(413)
    })

    it('el 413 sale por el formato de error de la API, sin trazas', async () => {
      const respuesta = await request(url)
        .post('/auth/register')
        .send({ fullName: 'a'.repeat(300_000), email: 'a@b.com', password: 'x'.repeat(12) })
        .expect(413)

      expect(respuesta.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
      expect(respuesta.text).not.toContain('node_modules')
    })

    it('el límite es 256 kB, no el de 100 kB que Express trae por defecto', async () => {
      // 200 kB pasa el parser y llega a la validación (el email es inválido a
      // propósito: 400 sin crear ninguna cuenta).
      await request(url)
        .post('/auth/register')
        .send({ fullName: 'a'.repeat(200_000), email: 'no-es-un-email', password: 'x'.repeat(12) })
        .expect(400)
    })
  })

  describe('trust proxy', () => {
    function responder(baseUrl: string, ip: string): request.Test {
      return request(baseUrl)
        .post(`/rsvp/${tokenInventado()}`)
        .set('X-Forwarded-For', ip)
        .send({ rsvp: 'CONFIRMED' })
    }

    it('por defecto X-Forwarded-For se ignora: cambiar de IP inventada no esquiva el límite', async () => {
      for (let i = 1; i <= 5; i += 1) await responder(url, `203.0.113.${i}`).expect(404)

      await responder(url, '203.0.113.99').expect(429)
    })

    it('con TRUST_PROXY=1 cada cliente real tiene su propio contador', async () => {
      fijarEntorno(
        { databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() },
        { CORS_ORIGINS: ADMIN, TRUST_PROXY: '1' },
      )
      const trasBalanceador = await arrancarAppDeTest()
      otrosCierres.push(trasBalanceador.cerrar)

      for (let i = 0; i < 5; i += 1) {
        await responder(trasBalanceador.url, '198.51.100.7').expect(404)
      }
      await responder(trasBalanceador.url, '198.51.100.7').expect(429)

      // Otro invitado detrás del mismo balanceador: su propio contador.
      await responder(trasBalanceador.url, '198.51.100.8').expect(404)
      // Un salto de confianza: lo que el cliente antepone a la cabecera no
      // cuenta; manda la dirección que añadió el balanceador.
      await responder(trasBalanceador.url, '1.2.3.4, 198.51.100.7').expect(429)
    })
  })
})
