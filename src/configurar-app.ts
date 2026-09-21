import type { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'

import { origenesPermitidos, type Env } from './config/env.schema'
import { RedisIoAdapter } from './modules/notifications/infrastructure/redis-io.adapter'
import { DomainExceptionFilter } from './shared/http/domain-exception.filter'

/**
 * Opciones de `NestFactory.create` que `configurarApp` presupone.
 *
 * `rawBody: true` NO cambia el parseo de JSON de ninguna ruta: Nest sigue
 * poniendo `req.body` como siempre y, además, guarda los bytes originales en
 * `req.rawBody`. El webhook de Resend (`POST /webhooks/resend`) los necesita
 * porque la firma Svix cubre los bytes exactos, y re-serializar `req.body` no
 * los reproduce. Coste: una copia del cuerpo por petición JSON, acotada por
 * `LIMITE_DE_CUERPO`.
 */
export const OPCIONES_DE_FABRICA = { rawBody: true } as const

/**
 * Tope de cualquier cuerpo. El mayor legítimo es un webhook de Resend (unos
 * pocos kB); 256 kB deja margen sin permitir que cada petición reserve megas.
 */
export const LIMITE_DE_CUERPO = '256kb'

/**
 * Todo lo que el arranque le hace a la app antes de `init()`/`listen()`, en un
 * sitio: `main.ts` lo usa y los tests e2e de arranque también
 * (`test/support/app.ts`), así que lo que prueban es lo que se despliega.
 *
 * No incluye lo que un test no puede compartir: el logger (`main.ts` pone
 * pino; los tests capturan con el suyo), `enableShutdownHooks` y `listen`.
 */
export async function configurarApp(app: NestExpressApplication, env: Env): Promise<void> {
  // Detrás de un balanceador, `req.ip` (la clave de TODOS los límites de ritmo)
  // tiene que salir de X-Forwarded-For; sin balanceador, NUNCA. Ver
  // `TRUST_PROXY` en `env.schema.ts`.
  app.set('trust proxy', env.TRUST_PROXY)

  // Cabeceras de seguridad por defecto (nosniff, HSTS, frame-ancestors…) y
  // fuera `X-Powered-By`, que sólo le dice al que sondea qué framework atacar.
  // La CSP sólo afecta a `/docs` (lo único que sirve HTML). Fuera de producción
  // se quita `upgrade-insecure-requests`: en `http://localhost` haría que el
  // navegador pidiera por https los scripts de Swagger UI, y la página saldría
  // en blanco.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null },
      },
    }),
  )

  // DESIGN-GAP (brief, Paso 2): el brief monta `express.json({ limit })` y un
  // `express.raw()` aparte para `/webhooks/resend`. Aquí no: la Tarea 13
  // verifica la firma sobre `req.rawBody` (`rawBody: true`), y `useBodyParser`
  // es la vía de Nest que conserva ese `verify`. Registrado antes de `init()`,
  // Nest ve el parser ya montado y no añade el suyo de 100 kB por defecto. Un
  // único parser JSON para todas las rutas, webhook incluido, con un límite.
  app.useBodyParser('json', { limit: LIMITE_DE_CUERPO })
  app.useBodyParser('urlencoded', { limit: LIMITE_DE_CUERPO, extended: true })

  // El refresh token viaja en una cookie httpOnly (nunca en el cuerpo ni en
  // localStorage): necesita el parser para que `req.cookies` exista.
  app.use(cookieParser())

  // Una sola allowlist para el HTTP y para Socket.IO (ver `origenesPermitidos`).
  const origenes = origenesPermitidos(env)
  app.enableCors({ origin: origenes, credentials: true })

  // DESIGN-GAP (brief, Paso 2): el brief añade `useGlobalPipes(new
  // ZodValidationPipe())`. No existe en el proyecto: cada ruta valida con su
  // esquema Zod explícito (`validarCon`), y un pipe global sin esquema no
  // validaría nada.
  app.useGlobalFilters(new DomainExceptionFilter())

  // DESIGN-GAP: el documento lista rutas, métodos y la autenticación, pero no
  // los esquemas de los cuerpos: los DTO son esquemas Zod, no clases de
  // `class-validator`, y `@nestjs/swagger` sólo lee clases decoradas.
  //
  // Apagado en producción salvo `DOCS_ENABLED=true` (ver `env.schema.ts`): el
  // documento no lleva nada secreto, pero expone la forma entera de la API a
  // quien no la necesita. `env.DOCS_ENABLED` ya resuelve ese defecto según
  // `NODE_ENV`, así que aquí sólo se lee.
  if (env.DOCS_ENABLED) {
    const documento = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Wedding Planner API')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    )
    SwaggerModule.setup('docs', app, documento, { jsonDocumentUrl: 'openapi.json' })
  }

  // Socket.IO sobre Redis. Sin este adapter, un usuario conectado a la
  // instancia B nunca recibe lo que emite la instancia A, y quien emite es el
  // WORKER de `notifications`, que puede ser otro proceso. Va antes de
  // `init`/`listen` (los gateways se montan al arrancar).
  const socketsSobreRedis = new RedisIoAdapter(app, origenes)
  await socketsSobreRedis.conectar(env.REDIS_URL)
  app.useWebSocketAdapter(socketsSobreRedis)
}
