import { execFileSync } from 'node:child_process'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

export interface PostgresDeTest {
  url: string
  stop: () => Promise<void>
}

/**
 * Postgres real en contenedor, con las migraciones aplicadas. NUNCA sqlite: un
 * dialecto distinto produce verdes falsos justo en lo que un repositorio existe
 * para hacer —restricciones, transacciones, el CHECK de event_vendors—, que es
 * lo único que un test de integración prueba de verdad.
 */
export async function startPostgres(): Promise<PostgresDeTest> {
  const contenedor: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('wedding_planner_test')
    .start()

  const url = contenedor.getConnectionUri()
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  })

  return {
    url,
    stop: async () => {
      await contenedor.stop()
    },
  }
}
