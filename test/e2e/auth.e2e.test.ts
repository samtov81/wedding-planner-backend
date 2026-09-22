import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import type { NestExpressApplication } from '@nestjs/platform-express'
import request, { type Response } from 'supertest'

import { MAIL_PORT } from '@/modules/mail/application/mail.port'
import type { FakeMailAdapter } from '@/modules/mail/infrastructure/mail.adapter.fake'

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
  let app: NestExpressApplication
  let url: string
  let cerrar: () => Promise<void>
  /**
   * El adaptador de correo que el contenedor ya inyectó (MAIL_DRIVER=fake).
   * Es la ÚNICA forma de leer el token de verificación desde fuera del caso de
   * uso: la tabla guarda sólo el hash y el token en claro no se registra en
   * ningún log a propósito.
   */
  let correo: FakeMailAdapter

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ app, url, cerrar } = await arrancarAppDeTest())
    correo = app.get<FakeMailAdapter>(MAIL_PORT)
  }, 120_000)

  /**
   * El correo sale por BullMQ, así que no está enviado cuando responde el 201:
   * hay que esperar a que el worker de la cola `email` lo procese. Se espera al
   * mensaje concreto, no a "que haya alguno", porque los tests de este fichero
   * comparten el mismo adaptador.
   */
  async function esperarCorreoA(destinatario: string): Promise<{ html: string; text: string }> {
    for (let intento = 0; intento < 100; intento += 1) {
      const mensaje = correo.enviados.find((m) => m.to === destinatario)
      if (mensaje !== undefined) return { html: mensaje.html ?? '', text: mensaje.text ?? '' }
      await new Promise((seguir) => setTimeout(seguir, 100))
    }
    throw new Error(`No llegó ningún correo a ${destinatario} en 10s`)
  }

  /** El token tal cual viaja en el enlace del correo. */
  function tokenDelEnlace(html: string): string {
    const encontrado = /verify-email\?token=([A-Za-z0-9_%-]+)/.exec(html)
    if (encontrado?.[1] === undefined) throw new Error('El correo no trae enlace de verificación')
    return decodeURIComponent(encontrado[1])
  }

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

    // El login exige el email verificado desde esta tarea: sin este paso el
    // 200 de más abajo pasaría a ser un 403 EMAIL_NOT_VERIFIED.
    const { html: htmlAna } = await esperarCorreoA('ana@test.com')
    await request(url)
      .post('/auth/verify-email')
      .send({ token: tokenDelEnlace(htmlAna) })
      .expect(200)

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

  it('sin token responde 401 con code UNAUTHORIZED', async () => {
    const res = await request(url).get('/auth/me').expect(401)
    expect((res.body as CuerpoError).code).toBe('UNAUTHORIZED')
  })

  it('con un token inválido responde 401 con code UNAUTHORIZED', async () => {
    const res = await request(url)
      .get('/auth/me')
      .set('Authorization', 'Bearer no-es-un-jwt')
      .expect(401)
    expect((res.body as CuerpoError).code).toBe('UNAUTHORIZED')
  })

  /**
   * Antes esto respondía 409 y convertía `/auth/register` en un oráculo de
   * enumeración de cuentas. Ahora las dos ramas son indistinguibles desde
   * fuera: mismo status y misma forma de respuesta. La diferencia sólo la ve
   * quien lee el buzón de esa dirección.
   */
  it('un registro duplicado responde 201 igual y no crea una segunda cuenta', async () => {
    const primero = await request(url)
      .post('/auth/register')
      .send({ email: 'duplicado@test.com', password: 'una-contraseña-larga', fullName: 'D' })
      .expect(201)

    const segundo = await request(url)
      .post('/auth/register')
      .send({ email: 'duplicado@test.com', password: 'otra-contraseña-larga', fullName: 'D2' })
      .expect(201)

    expect(segundo.body).toEqual(primero.body)

    // El correo de verificación del primer registro es el válido: el segundo
    // intento no genera cuenta nueva, así que no hay un segundo token que valga.
    const { html } = await esperarCorreoA('duplicado@test.com')
    await request(url)
      .post('/auth/verify-email')
      .send({ token: tokenDelEnlace(html) })
      .expect(200)

    // Y la cuenta original sigue siendo la suya: ni nombre ni contraseña nuevos.
    await request(url)
      .post('/auth/login')
      .send({ email: 'duplicado@test.com', password: 'una-contraseña-larga' })
      .expect(200)
    await request(url)
      .post('/auth/login')
      .send({ email: 'duplicado@test.com', password: 'otra-contraseña-larga' })
      .expect(401)
  })

  it('el ciclo de verificación de email: enlace del correo, segundo clic y token falso', async () => {
    await request(url)
      .post('/auth/register')
      .send({ email: 'verifica@test.com', password: 'una-contraseña-larga', fullName: 'Vera' })
      .expect(201)

    const { html } = await esperarCorreoA('verifica@test.com')
    const token = tokenDelEnlace(html)

    const primera = await request(url).post('/auth/verify-email').send({ token }).expect(200)
    expect(primera.body).toEqual({ outcome: 'verified' })

    // Un solo uso, pero el segundo clic (o el prefetch del cliente de correo)
    // no puede acabar en error: el usuario ya está verificado.
    const segunda = await request(url).post('/auth/verify-email').send({ token }).expect(200)
    expect(segunda.body).toEqual({ outcome: 'already_verified' })

    const basura = await request(url)
      .post('/auth/verify-email')
      .send({ token: 'esto-no-es-un-token' })
      .expect(200)
    expect(basura.body).toEqual({ outcome: 'invalid_or_expired' })
  })

  it('el aviso al email ya registrado sale sin enlace ni token', async () => {
    const alta = { email: 'avisada@test.com', password: 'una-contraseña-larga', fullName: 'Avi' }
    await request(url).post('/auth/register').send(alta).expect(201)
    await esperarCorreoA('avisada@test.com')

    await request(url)
      .post('/auth/register')
      .send({ ...alta, password: 'otra-contraseña-larga', fullName: 'Impostor' })
      .expect(201)

    // Dos correos a la misma dirección: el de verificación y el aviso. El aviso
    // es el segundo y no puede llevar nada accionable — quien lo provoca no es
    // quien lo recibe.
    for (let intento = 0; intento < 100 && correo.enviados.filter((m) => m.to === alta.email).length < 2; intento += 1) {
      await new Promise((seguir) => setTimeout(seguir, 100))
    }
    const aviso = correo.enviados.filter((m) => m.to === alta.email)[1]
    expect(aviso).toBeDefined()
    expect(aviso?.html).not.toContain('verify-email')
    expect(aviso?.html).not.toContain('href=')
  })

  it('verify-email sin token responde 400, no 500', async () => {
    await request(url).post('/auth/verify-email').send({}).expect(400)
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
