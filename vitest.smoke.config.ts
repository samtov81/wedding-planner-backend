import { defineConfig } from 'vitest/config'

/**
 * Tests de humo del build COMPILADO (`npm run test:smoke`). Configuración
 * aparte, sin el alias `@/` ni SWC: lo que se prueba lo arranca `node` a
 * secas, y el propio test sólo necesita Testcontainers y `fetch`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/smoke/**/*.smoke.test.ts'],
    testTimeout: 60_000,
  },
})
