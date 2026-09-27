import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'

// Sin el alias `@/`: esta config de smoke lo deja fuera a propósito (ver
// `vitest.smoke.config.ts`), así que la constante se importa por ruta relativa.
import { CIERRE_ORDENADO } from '../../src/shared/logging/cierre-ordenado'
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

  /** El entorno explícito del hijo, compartido por los dos procesos que se arrancan. */
  function entorno(puerto: number): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '',
      // Como en producción: pino en JSON, sin pino-pretty (que es devDependency).
      NODE_ENV: 'production',
      PORT: String(puerto),
      DATABASE_URL: pg.url,
      REDIS_URL: redis.getConnectionUrl(),
      JWT_ACCESS_SECRET: 's'.repeat(48),
      MAIL_DRIVER: 'resend',
      // En producción el remitente por defecto (`.test`) se rechaza al arrancar.
      MAIL_FROM: 'no-reply@weddingplanner.app',
      RESEND_API_KEY: 're_humo_no_se_usa',
      RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('secreto-del-test-de-humo').toString('base64')}`,
      APP_URL: 'http://localhost:5173',
      TRUST_PROXY: '1',
      // Swagger se apaga por defecto en producción (ver `env.schema.ts`); este
      // smoke SÍ quiere comprobar que `/openapi.json` se publica.
      DOCS_ENABLED: 'true',
    }
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    const puerto = await puertoLibre()
    base = `http://127.0.0.1:${puerto}`

    proceso = spawn(process.execPath, [MAIN], {
      env: entorno(puerto),
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

  it('si el puerto está ocupado TERMINA, en vez de quedarse de worker fantasma', async () => {
    // El segundo `npm run dev` es rutina en desarrollo, y `listen` falla con
    // EADDRINUSE. Lo que NO puede pasar es que el proceso sobreviva al fallo:
    // para cuando `listen` se ejecuta, la aplicación ya está construida y sus
    // workers de BullMQ ya están consumiendo las colas. Un proceso así no
    // escucha en ningún puerto —es invisible para `lsof`— pero le roba los
    // jobs al servidor bueno y los ejecuta con SU build, que es viejo. Se
    // detectó exactamente así: correos de verificación procesados por un
    // arranque fallido de minutos antes, sin rastro en los logs del servidor
    // que sí estaba escuchando.
    const puerto = Number(new URL(base).port)
    let salidaSegundo = ''
    const segundo = spawn(process.execPath, [MAIN], {
      env: entorno(puerto),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    segundo.stdout?.on('data', (trozo: Buffer) => (salidaSegundo += trozo.toString()))
    segundo.stderr?.on('data', (trozo: Buffer) => (salidaSegundo += trozo.toString()))

    try {
      const fin = new Promise<number | null>((ok) => segundo.once('exit', (code) => ok(code)))
      const plazo = new Promise<'colgado'>((ok) => setTimeout(() => ok('colgado'), 25_000))
      const resultado = await Promise.race([fin, plazo])

      // `toBe(1)` y no "distinto de null": salir con 0 diría que todo fue bien.
      expect(resultado).toBe(1)
      expect(salidaSegundo).toContain('EADDRINUSE')
    } finally {
      if (segundo.exitCode === null && segundo.signalCode === null) segundo.kill('SIGKILL')
    }

    // Y el primero sigue vivo y sirviendo: el intento fallido no se lo llevó.
    expect((await fetch(`${base}/health`)).status).toBe(200)
  }, 40_000)

  it('con SIGTERM corre los hooks de cierre y sale por la señal', async () => {
    // Que el proceso muera por SIGTERM NO prueba un cierre ordenado: sin
    // `enableShutdownHooks()` lo mata el manejador por defecto de Node, al
    // instante y sin cerrar Prisma, Redis ni los workers, y esta misma
    // aserción seguiría en verde. Lo que sólo puede haber escrito un cierre
    // ordenado es la línea del hook `onApplicationShutdown` de
    // `CierreOrdenado` (ver `src/shared/logging/cierre-ordenado.ts`, que
    // define el literal): se exige en el stdout del proceso.
    const fin = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((ok) =>
      proceso.once('exit', (code, signal) => ok({ code, signal })),
    )
    // El stdout puede tener trozos sin entregar cuando llega `exit`: se espera
    // también a que se cierre, o la aserción dependería de la suerte. Si no
    // hay `stdout` (no debería pasar con `stdio: ['ignore', 'pipe', 'pipe']`),
    // se resuelve ya: que falle la aserción de abajo, no un timeout de 20 s.
    const stdoutCerrado =
      proceso.stdout === null
        ? Promise.resolve()
        : new Promise<void>((ok) => proceso.stdout?.once('close', () => ok()))

    proceso.kill('SIGTERM')
    const { code, signal } = await fin
    await stdoutCerrado

    expect(salida).toContain(CIERRE_ORDENADO)
    // Y sale POR la señal, no con un código de error ni colgado hasta el SIGKILL.
    expect(code === 0 || signal === 'SIGTERM').toBe(true)
  }, 20_000)
})
