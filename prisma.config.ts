// Config de la CLI de Prisma: desde la v6, el CLI ya no carga `.env` solo. El
// runtime de la app sigue leyendo DATABASE_URL sólo por ENV (Tarea 1); este
// fichero es exclusivamente para invocar `prisma migrate`/`generate` a mano.
import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  engine: 'classic',
  datasource: {
    url: env('DATABASE_URL'),
  },
})
