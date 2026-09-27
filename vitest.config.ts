import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Los de humo arrancan `dist/`: necesitan un build previo y tienen su
    // propio comando (`npm run test:smoke`, ver `vitest.smoke.config.ts`).
    exclude: ['test/smoke/**', 'node_modules/**'],
    testTimeout: 30_000,
    alias: { '@': new URL('./src/', import.meta.url).pathname },
  },
})
