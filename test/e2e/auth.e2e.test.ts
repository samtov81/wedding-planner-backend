import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request, { type Response } from 'supertest'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { limpiarContadoresDeRitmo } from '../support/throttler'

interface CuerpoLogin {
  accessToken: string
  refreshToken?: string
}

interface CuerpoError {
  code: string
  message: string
}

interface CuerpoMe {
  id: string
  email: string
  fullName: string
  systemRole: string
}

/**
 * `Response.headers` de superagent lo tipa como `Record<string, string>`,
 * pero Node siempre entrega `set-cookie` como array (aunque sea de uno), por
 * el `,` que puede aparecer dentro de la fecha de `Expires`. Se lee así en
 * vez de confiar en el tipo declarado.
 */
function primeraCookie(res: Response): string | undefined {
  const cabecera = res.headers['set-cookie'] as unknown as string[] | undefined
  return cabecera?.[0]
}

describe('Auth e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
  }, 120_000)

  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
  })

  afterAll(async () => {
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('el ciclo completo: registro, login, acceso, refresco y cierre', async () => {
    await request(url)
      .post('/auth/register')
      .send({ email: 'ana@test.com', password: 'una-contraseña-larga', fullName: 'Ana' })
      .expect(201)

    const login = await request(url)
      .post('/auth/login')
      .send({ email: 'ana@test.com', password: 'una-contraseña-larga' })
      .expect(200)
    const cuerpoLogin = login.body as CuerpoLogin

    const cookie = primeraCookie(login)
    expect(cookie).toBeDefined()
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Strict/)
    expect(cuerpoLogin.accessToken).toBeDefined()
    expect(cuerpoLogin.refreshToken).toBeUndefined() // va en cookie, no en el cuerpo

    // `me` recarga el usuario de la base de datos, no reparte los claims del
    // token: por eso trae email y nombre, y por eso un usuario borrado o
    // degradado deja de pasar antes de que caduque su access token.
    const yo = await request(url)
      .get('/auth/me')
      .set('Authorization', `Bearer ${cuerpoLogin.accessToken}`)
      .expect(200)
    expect(yo.body as CuerpoMe).toMatchObject({
      email: 'ana@test.com',
      fullName: 'Ana',
      systemRole: 'USER',
    })

    // La cookie tal como llega del servidor (incluye Path y Expires): se
    // reenvía a mano porque `url` aquí no es un agente con jar propio.
    const refresco = await request(url)
      .post('/auth/refresh')
      .set('Cookie', cookie ?? '')
      .expect(200)
    const cuerpoRefresco = refresco.body as CuerpoLogin

    expect(cuerpoRefresco.accessToken).toBeDefined()
    expect(cuerpoRefresco.refreshToken).toBeUndefined()
    const cookieRotada = primeraCookie(refresco)
    expect(cookieRotada).toBeDefined()
    expect(cookieRotada).not.toBe(cookie)

    // El primer refresh token ya fue rotado: presentarlo de nuevo es un reuso
    // y tiene que caer con 401, no colarse. 401 y no 403 porque un refresh
    // muerto es un fallo de IDENTIDAD, no de permiso sobre un recurso: es lo
    // que hace que el cliente dispare "re-autenticar".
    const reuso = await request(url)
      .post('/auth/refresh')
      .set('Cookie', cookie ?? '')
      .expect(401)
    expect((reuso.body as CuerpoError).code).toBe('REFRESH_REUSED')

    // Logout con la cookie vigente (la rotada) revoca la familia entera.
    await request(url)
      .post('/auth/logout')
      .set('Cookie', cookieRotada ?? '')
      .expect(200)

    // Y ya no se puede refrescar con lo que quedó vivo: la familia está muerta.
    await request(url)
      .post('/auth/refresh')
      .set('Cookie', cookieRotada ?? '')
      .expect(401)
  })

  it('devuelve el mismo error para email inexistente y contraseña incorrecta', async () => {
    await request(url)
      .post('/auth/register')
      .send({ email: 'existe@test.com', password: 'una-contraseña-larga', fullName: 'Existe' })
      .expect(201)

    const inexistente = await request(url)
      .post('/auth/login')
      .send({ email: 'nadie@test.com', password: 'x'.repeat(12) })
      .expect(401)

    const malaClave = await request(url)
      .post('/auth/login')
      .send({ email: 'existe@test.com', password: 'incorrecta-pero-larga' })
      .expect(401)

    const cuerpoInexistente = inexistente.body as CuerpoError
    const cuerpoMalaClave = malaClave.body as CuerpoError
    expect(cuerpoInexistente.code).toBe(cuerpoMalaClave.code)
    expect(cuerpoInexistente.message).toBe(cuerpoMalaClave.message)
  })

  /**
   * Ratifica una LIMITACIÓN CONOCIDA, no el comportamiento deseado a largo
   * plazo: el 409 convierte `/auth/register` en un oráculo de enumeración de
   * cuentas (ver el riesgo aceptado en `auth.controller.ts`). Se fija así
   * mientras no exista el flujo de verificación de email (DESIGN-GAP #6) que
   * permitiría responder siempre 201; cuando exista, este test cambia con él.
   */
  it('rechaza un registro duplicado con 409 (limitación conocida, no objetivo)', async () => {
    await request(url)
      .post('/auth/register')
      .send({ email: 'duplicado@test.com', password: 'una-contraseña-larga', fullName: 'D' })
      .expect(201)

    await request(url)
      .post('/auth/register')
      .send({ email: 'duplicado@test.com', password: 'otra-contraseña-larga', fullName: 'D2' })
      .expect(409)
  })

  describe('límite de intentos de login', () => {
    function intentar(email: string): request.Test {
      return request(url).post('/auth/login').send({ email, password: 'no-es-esta' })
    }

    it('corta el sexto intento en 15 minutos contra la MISMA cuenta desde la misma IP', async () => {
      for (let i = 0; i < 5; i += 1) await intentar('victima@test.com').expect(401)

      const cortado = await intentar('victima@test.com').expect(429)

      expect(cortado.headers['retry-after-login']).toBeDefined()
    })

    it('la clave es IP + correo: otra cuenta desde la misma IP no hereda el bloqueo', async () => {
      // Limitar sólo por IP dejaría que un atacante bloqueara el login de toda
      // una oficina detrás de una misma IP. Otra cuenta cuenta desde cero.
      for (let i = 0; i < 5; i += 1) await intentar('bloqueada@test.com').expect(401)
      await intentar('bloqueada@test.com').expect(429)

      await intentar('otra-cuenta@test.com').expect(401)
    })

    it('el correo cuenta sin distinguir mayúsculas: variarlas no da intentos nuevos', async () => {
      for (let i = 0; i < 5; i += 1) await intentar('mayus@test.com').expect(401)

      await intentar('MAYUS@test.com').expect(429)
    })

    it('una IP que prueba MUCHOS correos acaba en 429 por el límite global (C22)', async () => {
      // La clave IP + correo da 5 intentos por correo. Sin el global por IP,
      // una sola IP podría probar una contraseña contra cada cuenta sin tope
      // (password spraying). Va el último: agota el global de esta ruta.
      let estado = 401
      let intentos = 0
      let respuesta: Response | undefined
      while (estado === 401 && intentos < 130) {
        respuesta = await intentar(`spray-${intentos}@test.com`)
        estado = respuesta.status
        intentos += 1
      }

      expect(estado).toBe(429)
      expect(intentos).toBeLessThanOrEqual(121)
      expect(respuesta?.headers['retry-after-global']).toBeDefined()
    })
  })
})
