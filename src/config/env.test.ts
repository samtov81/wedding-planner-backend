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

  describe('RESEND_WEBHOOK_SECRET', () => {
    const secretoValido = `whsec_${Buffer.from('s'.repeat(32)).toString('base64')}`

    it('con MAIL_DRIVER=resend es obligatorio: sin él, el webhook no puede verificar nada', () => {
      const conResend = { ...valido, MAIL_DRIVER: 'resend', RESEND_API_KEY: 're_x' }

      expect(() => loadEnv(conResend)).toThrow(/RESEND_WEBHOOK_SECRET/)
      expect(loadEnv({ ...conResend, RESEND_WEBHOOK_SECRET: secretoValido }).MAIL_DRIVER).toBe(
        'resend',
      )
    })

    it('con MAIL_DRIVER=fake es opcional', () => {
      expect(loadEnv(valido).RESEND_WEBHOOK_SECRET).toBeUndefined()
    })

    it('rechaza al arrancar un secreto que no tiene forma de secreto de Svix', () => {
      expect(() => loadEnv({ ...valido, RESEND_WEBHOOK_SECRET: 'mi-secreto' })).toThrow(
        /RESEND_WEBHOOK_SECRET/,
      )
      expect(() => loadEnv({ ...valido, RESEND_WEBHOOK_SECRET: 'whsec_!!no-base64!!' })).toThrow(
        /RESEND_WEBHOOK_SECRET/,
      )
    })
  })
})
