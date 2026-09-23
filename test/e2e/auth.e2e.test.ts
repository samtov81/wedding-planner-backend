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

  /** Espera al correo con ESE asunto: los tests comparten el adaptador y los destinatarios reciben varios. */
  async function esperarCorreoCon(destinatario: string, asunto: string): Promise<{ html: string }> {
    for (let intento = 0; intento < 100; intento += 1) {
      const mensaje = correo.enviados.find((m) => m.to === destinatario && m.subject === asunto)
      if (mensaje !== undefined) return { html: mensaje.html ?? '' }
      await new Promise((seguir) => setTimeout(seguir, 100))
    }
    throw new Error(`No llegó "${asunto}" a ${destinatario} en 10s`)
  }

  function tokenDeReset(html: string): string {
    const encontrado = /reset-password\?token=([A-Za-z0-9_%-]+)/.exec(html)
    if (encontrado?.[1] === undefined) throw new Error('El correo no trae enlace de recuperación')
    return decodeURIComponent(encontrado[1])
  }

  /** Registra y verifica una cuenta; devuelve la cookie de una sesión abierta. */
  async function cuentaConSesion(email: string, password: string): Promise<string> {
    await request(url).post('/auth/register').send({ email, password, fullName: 'Reset' }).expect(201)
    const { html } = await esperarCorreoA(email)
    await request(url).post('/auth/verify-email').send({ token: tokenDelEnlace(html) }).expect(200)
    const login = await request(url).post('/auth/login').send({ email, password }).expect(200)
    const cookie = primeraCookie(login)
    if (cookie === undefined) throw new Error('Sin cookie de refresh')
    return cookie
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

    // Fix crítico #1 (revisión final de rama): presentar el primer refresh
    // token INMEDIATAMENTE después de que ya fue rotado ya no cae como reuso.
    // Es exactamente el caso que la ventana de gracia de `RefreshUseCase`
    // existe para cubrir — dos pestañas con la misma cookie, o (como aquí)
    // dos peticiones seguidas contra el mismo token sin que medie tiempo real
    // entre ellas — así que responde 200 con un par de tokens NUEVO en vez de
    // tumbar la familia. El reuso genuino, pasada la ventana de diez
    // segundos, está cubierto a nivel de unidad en
    // `refresh.use-case.test.ts` con el reloj adelantado de verdad; repetirlo
    // aquí exigiría un `sleep` real de más de diez segundos sólo para este
    // test, que no compensa frente a la cobertura que ya existe.
    const graciaConcurrente = await request(url)
      .post('/auth/refresh')
      .set('Cookie', cookie ?? '')
      .expect(200)
    const cuerpoGracia = graciaConcurrente.body as CuerpoLogin
    expect(cuerpoGracia.accessToken).toBeDefined()
    const cookieDeGracia = primeraCookie(graciaConcurrente)
    expect(cookieDeGracia).toBeDefined()
    // Y la rotación normal SÍ revocó a `cookieRotada`: la ventana de gracia la
    // avanzó una vez más, no le devolvió el mismo token que ya tenía.
    expect(cookieDeGracia).not.toBe(cookieRotada)

    // Logout con la cookie vigente (la de la ventana de gracia) revoca la
    // familia entera.
    await request(url)
      .post('/auth/logout')
      .set('Cookie', cookieDeGracia ?? '')
      .expect(200)

    // Y ya no se puede refrescar con lo que quedó vivo: la familia está muerta.
    await request(url)
      .post('/auth/refresh')
      .set('Cookie', cookieDeGracia ?? '')
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

  describe('reenvío del correo de verificación', () => {
    it('devuelve el MISMO 202 y el mismo cuerpo exista la cuenta o no', async () => {
      await request(url)
        .post('/auth/register')
        .send({ email: 'sinverificar@test.com', password: 'una-contraseña-larga', fullName: 'Sin Verificar' })
        .expect(201)

      await request(url)
        .post('/auth/register')
        .send({ email: 'verificada@test.com', password: 'una-contraseña-larga', fullName: 'Verificada' })
        .expect(201)
      const { html } = await esperarCorreoA('verificada@test.com')
      await request(url).post('/auth/verify-email').send({ token: tokenDelEnlace(html) }).expect(200)

      const pendiente = await request(url)
        .post('/auth/resend-verification')
        .send({ email: 'sinverificar@test.com' })
      const inexistente = await request(url)
        .post('/auth/resend-verification')
        .send({ email: 'nadie@test.com' })
      const verificada = await request(url)
        .post('/auth/resend-verification')
        .send({ email: 'verificada@test.com' })

      // Este test es la defensa contra la enumeración de cuentas: si alguna vez
      // divergen status o cuerpo, el endpoint dice quién tiene cuenta aquí.
      expect(pendiente.status).toBe(202)
      expect(inexistente.status).toBe(202)
      expect(verificada.status).toBe(202)
      expect(inexistente.body).toEqual(pendiente.body)
      expect(verificada.body).toEqual(pendiente.body)
    })

    it('rechaza un email mal formado con 400', async () => {
      const res = await request(url).post('/auth/resend-verification').send({ email: 'no-es-un-email' })

      expect(res.status).toBe(400)
    })

    it('el cuarto intento en una hora contra el mismo IP+correo da 429', async () => {
      function pedir(): request.Test {
        return request(url).post('/auth/resend-verification').send({ email: 'limite-resend@test.com' })
      }

      for (let i = 0; i < 3; i += 1) await pedir().expect(202)

      const cortado = await pedir()

      expect(cortado.status).toBe(429)
    })
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

  describe('recuperación de contraseña', () => {
    it('ciclo completo: pedir enlace, fijar contraseña, sesiones cerradas y aviso', async () => {
      const cookieVieja = await cuentaConSesion('reset@test.com', 'contraseña-vieja-1')

      await request(url).post('/auth/forgot-password').send({ email: 'reset@test.com' }).expect(202)
      const { html } = await esperarCorreoCon('reset@test.com', 'Reset your password')

      await request(url)
        .post('/auth/reset-password')
        .send({ token: tokenDeReset(html), password: 'contraseña-nueva-1' })
        .expect(200, { ok: true })

      await request(url).post('/auth/login').send({ email: 'reset@test.com', password: 'contraseña-vieja-1' }).expect(401)
      await request(url).post('/auth/login').send({ email: 'reset@test.com', password: 'contraseña-nueva-1' }).expect(200)
      await request(url).post('/auth/refresh').set('Cookie', cookieVieja).expect(401)
      await esperarCorreoCon('reset@test.com', 'Your password was changed')
    })

    it('el mismo enlace no sirve dos veces: 422 RESET_TOKEN_INVALID', async () => {
      await cuentaConSesion('reset-dos@test.com', 'contraseña-vieja-1')
      await request(url).post('/auth/forgot-password').send({ email: 'reset-dos@test.com' }).expect(202)
      const token = tokenDeReset((await esperarCorreoCon('reset-dos@test.com', 'Reset your password')).html)

      const [a, b] = await Promise.all([
        request(url).post('/auth/reset-password').send({ token, password: 'nueva-contraseña-a' }),
        request(url).post('/auth/reset-password').send({ token, password: 'nueva-contraseña-b' }),
      ])

      expect([a.status, b.status].sort()).toEqual([200, 422])
      const perdedora = a.status === 422 ? a : b
      expect((perdedora.body as CuerpoError).code).toBe('RESET_TOKEN_INVALID')
    })

    it('una cuenta sin verificar puede restablecer y queda verificada', async () => {
      await request(url)
        .post('/auth/register')
        .send({ email: 'sinverif-reset@test.com', password: 'contraseña-vieja-1', fullName: 'SV' })
        .expect(201)
      await request(url).post('/auth/forgot-password').send({ email: 'sinverif-reset@test.com' }).expect(202)
      const { html } = await esperarCorreoCon('sinverif-reset@test.com', 'Reset your password')

      await request(url)
        .post('/auth/reset-password')
        .send({ token: tokenDeReset(html), password: 'contraseña-nueva-1' })
        .expect(200)

      await request(url)
        .post('/auth/login')
        .send({ email: 'sinverif-reset@test.com', password: 'contraseña-nueva-1' })
        .expect(200)
    })

    it('forgot-password responde lo MISMO exista la cuenta o no', async () => {
      await cuentaConSesion('existe-reset@test.com', 'contraseña-vieja-1')

      const existe = await request(url).post('/auth/forgot-password').send({ email: 'existe-reset@test.com' })
      const noExiste = await request(url).post('/auth/forgot-password').send({ email: 'nadie-reset@test.com' })

      expect(existe.status).toBe(202)
      expect(noExiste.status).toBe(202)
      expect(noExiste.body).toEqual(existe.body)
    })

    it('forgot-password con email mal formado da 400', async () => {
      await request(url).post('/auth/forgot-password').send({ email: 'no-es-email' }).expect(400)
    })

    it('reset-password: token falso 422; contraseña corta, larga o token enorme 400; nunca 500', async () => {
      await request(url).post('/auth/reset-password').send({ token: 'no-existe', password: 'contraseña-larga' }).expect(422)
      await request(url).post('/auth/reset-password').send({ token: 'x', password: 'corta' }).expect(400)
      await request(url).post('/auth/reset-password').send({ token: 'x', password: 'a'.repeat(129) }).expect(400)
      await request(url).post('/auth/reset-password').send({ token: 'a'.repeat(10_000), password: 'contraseña-larga' }).expect(400)
      await request(url).post('/auth/reset-password').send({ token: ' ¿?%00 ', password: 'contraseña-larga' }).expect(422)
    })

    it('el cuarto forgot-password en una hora contra el mismo IP+correo da 429', async () => {
      const pedir = () => request(url).post('/auth/forgot-password').send({ email: 'limite-forgot@test.com' })
      for (let i = 0; i < 3; i += 1) await pedir().expect(202)

      expect((await pedir()).status).toBe(429)
    })

    it('el undécimo reset-password en 15 minutos desde la misma IP da 429', async () => {
      const pedir = () => request(url).post('/auth/reset-password').send({ token: 'falso', password: 'contraseña-larga' })
      for (let i = 0; i < 10; i += 1) await pedir().expect(422)

      expect((await pedir()).status).toBe(429)
    })
  })
})
