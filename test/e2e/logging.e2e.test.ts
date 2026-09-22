import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { Logger } from 'nestjs-pino'
import request from 'supertest'

import { AppModule } from '@/app.module'
import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { configurarApp, OPCIONES_DE_FABRICA } from '@/configurar-app'
import { generarTokenInvitacion } from '@/modules/guests/domain/invitation'
import { DESTINO_DE_LOGS } from '@/shared/logging/registro.module'

import { fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'

/** Destino de pino que guarda cada línea JSON en memoria en vez de en stdout. */
class LogsCapturados {
  readonly lineas: string[] = []
  write(linea: string): void {
    this.lineas.push(linea)
  }
  todo(): string {
    return this.lineas.join('')
  }
}

describe('Logs de peticiones (pino-http) e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let app: NestExpressApplication
  let url: string
  let prisma: PrismaClient
  const logs = new LogsCapturados()

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    // `info`: en test el nivel por defecto es `silent` y no habría nada que mirar.
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() }, { LOG_LEVEL: 'info' })

    const modulo = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DESTINO_DE_LOGS)
      .useValue(logs)
      .compile()
    app = modulo.createNestApplication<NestExpressApplication>({
      ...OPCIONES_DE_FABRICA,
      bufferLogs: true,
    })
    // Como `main.ts`: el logger de Nest es el de pino.
    app.useLogger(app.get(Logger))
    await configurarApp(app, app.get<Env>(ENV))
    // Escuchando de verdad (ver `arrancarAppDeTest`, `test/support/app.ts`):
    // un servidor que no escucha hace que supertest abra un puerto efímero
    // POR PETICIÓN, y bajo la suite completa alguna acaba en otro proceso.
    await app.listen(0, '127.0.0.1')
    url = (await app.getUrl()).replace('[::1]', '127.0.0.1')
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
  }, 240_000)

  afterAll(async () => {
    delete process.env.LOG_LEVEL
    await prisma.$disconnect()
    await app.close()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  beforeEach(() => {
    logs.lineas.length = 0
  })

  it('el token del RSVP en la ruta no llega al log, y la petición SÍ se registra', async () => {
    const { token } = generarTokenInvitacion()

    await request(url).get(`/rsvp/${token}`).expect(404)
    await request(url).post(`/RSVP/${token}?x=1`).send({ rsvp: 'CONFIRMED' }).expect(404)

    const todo = logs.todo()
    expect(todo).not.toContain(token)
    // No puede ser verde por no registrar nada.
    expect(todo).toContain('/rsvp/[REDACTADO]')
    expect(todo).toContain('/RSVP/[REDACTADO]?x=1')
  })

  it('el token del RSVP en la cabecera Referer tampoco llega al log', async () => {
    // Mismo origen (API tras `/api` en el host del frontend): cada llamada que
    // hace la página `${APP_URL}/rsvp/<token>` lleva ese Referer.
    const { token } = generarTokenInvitacion()

    await request(url)
      .get('/auth/me')
      .set('Referer', `https://app.example.com/rsvp/${token}?utm=x`)
      .expect(401)

    const todo = logs.todo()
    expect(todo).not.toContain(token)
    // Se registra, tachado: la cabecera sigue sirviendo para depurar.
    expect(todo).toContain('"referer":"https://app.example.com/rsvp/[REDACTADO]?utm=x"')
  })

  it('el token del RSVP en las cabeceras de proxy tampoco llega al log', async () => {
    // `X-Original-URI` / `X-Forwarded-Uri` / `X-Rewrite-Url`: las añade un
    // proxy inverso (nginx `auth_request`, Traefik ForwardAuth) con la URL
    // ORIGINAL de la petición, token incluido si esa era la ruta.
    const { token } = generarTokenInvitacion()

    await request(url)
      .get('/auth/me')
      .set('X-Original-URI', `/rsvp/${token}`)
      .set('X-Forwarded-Uri', `/rsvp/${token}`)
      .set('X-Rewrite-Url', `/rsvp/${token}`)
      .expect(401)

    const todo = logs.todo()
    expect(todo).not.toContain(token)
    expect(todo).toContain('"x-original-uri":"/rsvp/[REDACTADO]"')
    expect(todo).toContain('"x-forwarded-uri":"/rsvp/[REDACTADO]"')
    expect(todo).toContain('"x-rewrite-url":"/rsvp/[REDACTADO]"')
  })

  it('las credenciales de las cabeceras no llegan al log', async () => {
    await request(url)
      .get('/auth/me')
      .set('Authorization', 'Bearer secreto-del-bearer')
      .set('Cookie', 'refresh_token=secreto-de-la-cookie')
      .set('svix-signature', 'v1,secreto-de-la-firma')
      .set('webhook-signature', 'v1,secreto-de-la-otra-firma')
      .expect(401)

    const todo = logs.todo()
    for (const secreto of ['secreto-del-bearer', 'secreto-de-la-cookie', 'secreto-de-la-firma']) {
      expect(todo).not.toContain(secreto)
    }
    expect(todo).not.toContain('secreto-de-la-otra-firma')
    expect(todo).toContain('[REDACTADO]')
    expect(todo).toContain('/auth/me')
  })

  it('el refresh token que la API pone en Set-Cookie no llega al log', async () => {
    const credenciales = { email: 'logs@test.com', password: 'una-contraseña-larga' }
    await request(url)
      .post('/auth/register')
      .send({ ...credenciales, fullName: 'Logs' })
      .expect(201)

    // El login exige el email verificado (Tarea 2): este test no ejercita ese
    // flujo, así que se marca directo en base de datos.
    await prisma.user.update({
      where: { email: credenciales.email },
      data: { emailVerifiedAt: new Date() },
    })

    const { headers } = await request(url).post('/auth/login').send(credenciales).expect(200)

    const cookies = ([] as string[]).concat(headers['set-cookie'] ?? [])
    expect(cookies.length).toBeGreaterThan(0)
    const valores = cookies.map((c) => c.split(';')[0]?.split('=')[1] ?? '')
    const todo = logs.todo()
    for (const valor of valores) {
      expect(valor.length).toBeGreaterThan(10)
      expect(todo).not.toContain(valor)
    }
  })

  it('el x-request-id de la respuesta es el reqId del log: se puede seguir la petición', async () => {
    const { headers } = await request(url).get('/health/ready').set('x-request-id', 'sigue-me-1')

    expect(headers['x-request-id']).toBe('sigue-me-1')
    // Las sondas no se registran (una línea cada pocos segundos por pod no
    // aporta nada); una ruta normal sí, con su id.
    expect(logs.todo()).not.toContain('sigue-me-1')
    await request(url).get('/auth/me').set('x-request-id', 'sigue-me-2').expect(401)
    expect(logs.todo()).toContain('"id":"sigue-me-2"')
  })
})
