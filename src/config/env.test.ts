import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

import { EnvValidationError, loadEnv } from './env'
import { envSchema, origenesPermitidos } from './env.schema'

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

  describe('NODE_ENV=production', () => {
    // Un entorno de producción por lo demás VÁLIDO: el `superRefine` no corre si
    // otra variable ya falla, así que cada test cambia exactamente una cosa.
    const produccion: NodeJS.ProcessEnv = {
      ...valido,
      NODE_ENV: 'production',
      MAIL_DRIVER: 'resend',
      MAIL_FROM: 'no-reply@weddingplanner.app',
      RESEND_API_KEY: 're_x',
      RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('s'.repeat(32)).toString('base64')}`,
    }

    it('un entorno de producción completo arranca', () => {
      expect(loadEnv(produccion).MAIL_DRIVER).toBe('resend')
    })

    it('exige MAIL_DRIVER=resend: el fake marcaría como enviados correos que nadie recibe', () => {
      const { MAIL_DRIVER: _omitido, ...sinDriver } = produccion

      expect(() => loadEnv(sinDriver)).toThrow(/MAIL_DRIVER/)
      expect(() => loadEnv({ ...produccion, MAIL_DRIVER: 'fake' })).toThrow(/MAIL_DRIVER/)
    })

    it('rechaza el MAIL_FROM por defecto y cualquier dominio reservado que no recibe correo', () => {
      const { MAIL_FROM: _omitido, ...sinRemitente } = produccion

      expect(() => loadEnv(sinRemitente)).toThrow(/MAIL_FROM/)
      for (const reservado of ['a@b.example', 'a@b.invalid', 'a@b.localhost', 'a@B.TEST']) {
        expect(() => loadEnv({ ...produccion, MAIL_FROM: reservado })).toThrow(/MAIL_FROM/)
      }
    })

    it('rechaza el secreto JWT de ejemplo de .env.example', () => {
      const ejemplo = parseEnv(readFileSync('.env.example', 'utf8'))

      expect(() =>
        loadEnv({ ...produccion, JWT_ACCESS_SECRET: ejemplo.JWT_ACCESS_SECRET }),
      ).toThrow(/JWT_ACCESS_SECRET/)
    })

    it('fuera de producción, esas mismas reglas no aplican (local y test usan el fake)', () => {
      const ejemplo = parseEnv(readFileSync('.env.example', 'utf8'))

      expect(loadEnv({ ...valido, JWT_ACCESS_SECRET: ejemplo.JWT_ACCESS_SECRET }).MAIL_FROM).toBe(
        'no-reply@weddingplanner.test',
      )
    })
  })

  describe('CORS_ORIGINS', () => {
    it('sin variable, la allowlist es sólo el origen del frontend (APP_URL)', () => {
      expect(origenesPermitidos(loadEnv(valido))).toEqual(['http://localhost:5173'])
    })

    it('trocea por comas, recorta espacios y añade APP_URL sin duplicarlo', () => {
      const env = loadEnv({
        ...valido,
        CORS_ORIGINS: ' https://admin.example.com , http://localhost:5173,',
      })

      expect(origenesPermitidos(env)).toEqual([
        'http://localhost:5173',
        'https://admin.example.com',
      ])
    })

    it('rechaza `*`: con credenciales ni siquiera es legal', () => {
      expect(() => loadEnv({ ...valido, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/)
    })

    it('rechaza lo que no es un ORIGEN exacto (ruta, barra final, sin esquema)', () => {
      for (const malo of ['https://a.com/', 'https://a.com/app', 'a.com', 'ftp://a.com']) {
        expect(() => loadEnv({ ...valido, CORS_ORIGINS: malo })).toThrow(/CORS_ORIGINS/)
      }
    })
  })

  describe('TRUST_PROXY', () => {
    it('por defecto NO confía en X-Forwarded-For', () => {
      expect(loadEnv(valido).TRUST_PROXY).toBe(false)
    })

    it('acepta un número de saltos', () => {
      expect(loadEnv({ ...valido, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1)
      expect(loadEnv({ ...valido, TRUST_PROXY: '0' }).TRUST_PROXY).toBe(false)
    })

    it('acepta una lista de IPs, subredes o palabras clave de Express', () => {
      const env = loadEnv({ ...valido, TRUST_PROXY: 'loopback, 10.0.0.0/8,fd00::1' })

      expect(env.TRUST_PROXY).toEqual(['loopback', '10.0.0.0/8', 'fd00::1'])
    })

    it('rechaza `true`: confiar en cualquier X-Forwarded-For deja falsear la IP', () => {
      expect(() => loadEnv({ ...valido, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/)
    })

    it('rechaza basura en vez de ignorarla en silencio', () => {
      for (const malo of ['-1', '1.5', 'balanceador', '10.0.0.0/99', '300.1.1.1']) {
        expect(() => loadEnv({ ...valido, TRUST_PROXY: malo })).toThrow(/TRUST_PROXY/)
      }
    })
  })

  describe('JWT_ACCESS_TTL', () => {
    it('rechaza al arrancar una duración que `jsonwebtoken` no sabe leer', () => {
      expect(() => loadEnv({ ...valido, JWT_ACCESS_TTL: '15minutes' })).toThrow(/JWT_ACCESS_TTL/)
    })

    it('vacía (`JWT_ACCESS_TTL=` en el .env) toma el valor por defecto', () => {
      expect(loadEnv({ ...valido, JWT_ACCESS_TTL: '' }).JWT_ACCESS_TTL).toBe('15m')
    })

    it('acepta un número seguido de s, m, h o d', () => {
      expect(loadEnv({ ...valido, JWT_ACCESS_TTL: '1h' }).JWT_ACCESS_TTL).toBe('1h')
    })
  })

  describe('LOG_LEVEL', () => {
    it('es opcional y, si viene, tiene que ser un nivel de pino', () => {
      expect(loadEnv(valido).LOG_LEVEL).toBeUndefined()
      expect(loadEnv({ ...valido, LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe('debug')
      expect(() => loadEnv({ ...valido, LOG_LEVEL: 'verboso' })).toThrow(/LOG_LEVEL/)
    })
  })

  it('una variable opcional vacía (`KEY=` en el .env) cuenta como ausente', () => {
    const env = loadEnv({ ...valido, RESEND_API_KEY: '', RESEND_WEBHOOK_SECRET: '', LOG_LEVEL: '' })

    expect(env.RESEND_API_KEY).toBeUndefined()
    expect(env.RESEND_WEBHOOK_SECRET).toBeUndefined()
    expect(env.LOG_LEVEL).toBeUndefined()
  })

  describe('.env.example', () => {
    // Vitest corre desde la raíz del repo.
    const ejemplo = parseEnv(readFileSync('.env.example', 'utf8'))

    it('documenta TODAS las variables del esquema: ninguna se descubre al desplegar', () => {
      expect(Object.keys(ejemplo).sort()).toEqual(Object.keys(envSchema.shape).sort())
    })

    it('tal cual, es un entorno válido para arrancar en local', () => {
      expect(() => loadEnv(ejemplo)).not.toThrow()
    })
  })
})
