import { EnvValidationError, loadEnv } from './env'

const valido: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/wp',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  APP_URL: 'http://localhost:5173',
}

describe('loadEnv', () => {
  it('devuelve un entorno tipado cuando todo está presente', () => {
    const env = loadEnv(valido)

    expect(env.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/wp')
    expect(env.PORT).toBe(3000)
    expect(env.MAIL_DRIVER).toBe('fake')
  })

  it('lanza nombrando LA variable que falta, no un error genérico', () => {
    const { JWT_ACCESS_SECRET: _omitida, ...sinSecreto } = valido

    expect(() => loadEnv(sinSecreto)).toThrow(EnvValidationError)
    expect(() => loadEnv(sinSecreto)).toThrow(/JWT_ACCESS_SECRET/)
  })

  it('rechaza un secreto demasiado corto para firmar', () => {
    expect(() => loadEnv({ ...valido, JWT_ACCESS_SECRET: 'corto' })).toThrow(/JWT_ACCESS_SECRET/)
  })

  it('acumula TODAS las variables inválidas en un solo mensaje', () => {
    const roto = { ...valido, DATABASE_URL: 'no-es-una-url', REDIS_URL: 'tampoco' }

    expect(() => loadEnv(roto)).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/)
  })
})
