import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'

import { AppModule } from '@/app.module'
import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { configurarApp, OPCIONES_DE_FABRICA } from '@/configurar-app'

/**
 * Fija el entorno que `ConfigModule` lee UNA vez al construirse. Va antes de
 * crear la app; `extra` añade o pisa variables para el test que lo necesite.
 */
export function fijarEntorno(
  urls: { databaseUrl: string; redisUrl: string },
  extra: Record<string, string> = {},
): void {
  process.env.NODE_ENV = 'test'
  process.env.DATABASE_URL = urls.databaseUrl
  process.env.REDIS_URL = urls.redisUrl
  process.env.JWT_ACCESS_SECRET = 'x'.repeat(32)
  process.env.JWT_ACCESS_TTL = '15m'
  process.env.REFRESH_TTL_DAYS = '30'
  process.env.MAIL_DRIVER = 'fake'
  process.env.APP_URL = 'http://localhost:5173'
  Object.assign(process.env, extra)
}

/**
 * La app EXACTAMENTE como la arranca `main.ts` (mismas opciones de fábrica y
 * mismo `configurarApp`), salvo el logger, el `listen` y los hooks de apagado.
 * Es lo que hace que un test de cabeceras, CORS o límite de cuerpo pruebe lo
 * que se despliega y no una copia a mano.
 */
export async function crearAppComoMain(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...OPCIONES_DE_FABRICA,
    logger: false,
  })
  await configurarApp(app, app.get<Env>(ENV))
  await app.init()
  return app
}
