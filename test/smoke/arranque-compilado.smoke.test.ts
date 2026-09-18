import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'

import { startPostgres, type PostgresDeTest } from '../support/containers'

// Vitest corre desde la raíz del repo (el `package.json` que lo lanza).
const MAIN = resolve(process.cwd(), 'dist/main.js')

/** Un puerto libre en loopback, para no chocar con nada del host. */
async function puertoLibre(): Promise<number> {
  const servidor = createServer()
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok))
  const direccion = servidor.address()
  await new Promise<void>((ok) => servidor.close(() => ok()))
  if (direccion === null || typeof direccion === 'string') throw new Error('sin puerto')
  return direccion.port
}

/**
 * El build compilado (`dist/`), arrancado con `node` A SECAS: sin el resolver
 * de Vitest, sin `-r`, sin nada que no haya en producción. Es la prueba del
 * ruling C20: con los alias `@/` sin reescribir, `tsc` compilaba pero
 * `node dist/…/main.js` moría con `Cannot find module`, y ningún test lo veía
 * porque Vitest resuelve el alias por su cuenta.
 *
 * Postgres y Redis son los de Testcontainers; el proceso recibe un entorno
 * EXPLÍCITO (no hereda `process.env`), así que no puede acabar hablando con
 * servicios del host por una variable que se cuele.
 */
describe('build compilado', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let proceso: ChildProcess
  let base: string
  let salida = ''

  async function esperarSalud(ms: number): Promise<void> {
    const limite = Date.now() + ms
    while (Date.now() < limite) {
      if (proceso.exitCode !== null) {
        // Sin `dist/main.js` también acaba aquí: `npm run test:smoke` compila antes.
        throw new Error(`el proceso salió con código ${proceso.exitCode}:\n${salida}`)
      }
      try {
        if ((await fetch(`${base}/health`)).ok) return
      } catch {
        // Aún no escucha.
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`/health no respondió en ${ms} ms:\n${salida}`)
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    const puerto = await puertoLibre()
    base = `http://127.0.0.1:${puerto}`

    proceso = spawn(process.execPath, [MAIN], {
      env: {
        PATH: process.env.PATH ?? '',
        // Como en producción: pino en JSON, sin pino-pretty (que es devDependency).
        NODE_ENV: 'production',
        PORT: String(puerto),
        DATABASE_URL: pg.url,
        REDIS_URL: redis.getConnectionUrl(),
        JWT_ACCESS_SECRET: 's'.repeat(48),
        MAIL_DRIVER: 'resend',
        RESEND_API_KEY: 're_humo_no_se_usa',
        RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('secreto-del-test-de-humo').toString('base64')}`,
        APP_URL: 'http://localhost:5173',
        TRUST_PROXY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proceso.stdout?.on('data', (trozo: Buffer) => (salida += trozo.toString()))
    proceso.stderr?.on('data', (trozo: Buffer) => (salida += trozo.toString()))

    await esperarSalud(30_000)
  }, 240_000)

  afterAll(async () => {
    if (proceso.exitCode === null && proceso.signalCode === null) proceso.kill('SIGKILL')
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('arranca con `node dist/main.js` y /health responde 200', async () => {
    const respuesta = await fetch(`${base}/health`)

    expect(respuesta.status).toBe(200)
    expect(await respuesta.json()).toEqual({ status: 'ok' })
    expect(respuesta.headers.get('x-powered-by')).toBeNull()
    // En producción la CSP sí fuerza https (ver `configurarApp`).
    expect(respuesta.headers.get('content-security-policy')).toContain('upgrade-insecure-requests')
  })

  it('/health/ready ve la base de datos y Redis', async () => {
    const respuesta = await fetch(`${base}/health/ready`)

    expect(respuesta.status).toBe(200)
  })

  it('publica el documento OpenAPI', async () => {
    const respuesta = await fetch(`${base}/openapi.json`)
    const documento = (await respuesta.json()) as { openapi?: string; paths?: object }

    expect(respuesta.status).toBe(200)
    expect(documento.openapi).toMatch(/^3\./)
    expect(Object.keys(documento.paths ?? {})).toEqual(
      expect.arrayContaining(['/health', '/auth/login', '/rsvp/{token}']),
    )
  })

  it('registra en JSON (pino), no con el logger de consola de Nest', () => {
    const lineas = salida.split('\n').filter((l) => l.trim() !== '')

    expect(lineas.length).toBeGreaterThan(0)
    for (const linea of lineas) expect(() => JSON.parse(linea) as unknown).not.toThrow()
  })

  it('con SIGTERM cierra ordenadamente y sale', async () => {
    const fin = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((ok) =>
      proceso.once('exit', (code, signal) => ok({ code, signal })),
    )

    proceso.kill('SIGTERM')
    const { code, signal } = await fin

    // `enableShutdownHooks` cierra la app y vuelve a lanzarse la señal: sale
    // POR la señal, no con un código de error ni colgado hasta el SIGKILL.
    expect(code === 0 || signal === 'SIGTERM').toBe(true)
  }, 20_000)
})
