import type { PasswordHasher } from '@/modules/users/application/password-hasher.port'
import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { CredencialesInvalidasError } from '../domain/auth-errors'
import { SessionRepositoryEnMemoria } from '../infrastructure/session.repository.fake'
import { LoginUseCase } from './login.use-case'
import { hashToken, TokenService } from './token.service'

/**
 * Doble mínimo de `PasswordHasher`: modela un hash como `hash:<plano>` y
 * "verifica" comparando el sufijo. Sirve para comprobar la LÓGICA del caso
 * de uso (qué compara, qué lanza) sin pagar el coste real de Argon2 en cada
 * test; la latencia real de Argon2 ya se cubre en `argon2-password-hasher.test.ts`.
 */
class HasherDePrueba implements PasswordHasher {
  llamadasAVerify = 0

  hash(plano: string): Promise<string> {
    return Promise.resolve(`hash:${plano}`)
  }

  verify(hash: string, plano: string): Promise<boolean> {
    this.llamadasAVerify += 1
    return Promise.resolve(hash === `hash:${plano}`)
  }
}

describe('LoginUseCase', () => {
  const tokens = new TokenService({
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    JWT_ACCESS_TTL: '15m',
    REFRESH_TTL_DAYS: 30,
  })
  let usuarios: UserRepositoryEnMemoria
  let sesiones: SessionRepositoryEnMemoria
  let hasher: HasherDePrueba
  let caso: LoginUseCase

  beforeEach(() => {
    usuarios = new UserRepositoryEnMemoria([
      {
        id: 'user-1',
        email: 'ana@test.com',
        fullName: 'Ana',
        systemRole: 'USER',
        emailVerifiedAt: null,
        passwordHash: 'hash:clave-correcta',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    sesiones = new SessionRepositoryEnMemoria()
    hasher = new HasherDePrueba()
    caso = new LoginUseCase(usuarios, hasher, sesiones, tokens)
  })

  it('devuelve accessToken y refreshToken con credenciales correctas', async () => {
    const resultado = await caso.ejecutar({ email: 'ana@test.com', password: 'clave-correcta' })

    expect(resultado.accessToken).toMatch(/^eyJ/)
    expect(resultado.refreshToken).toBeTypeOf('string')
  })

  it('crea la sesión con un familyId nuevo en cada login', async () => {
    const primero = await caso.ejecutar({ email: 'ana@test.com', password: 'clave-correcta' })
    const segundo = await caso.ejecutar({ email: 'ana@test.com', password: 'clave-correcta' })

    const sesion1 = await sesiones.buscarPorHash(hashToken(primero.refreshToken))
    const sesion2 = await sesiones.buscarPorHash(hashToken(segundo.refreshToken))

    // Dos logins => dos familias distintas: la rotación en refresh reutiliza
    // la familia, pero el login SIEMPRE empieza una nueva.
    expect(sesion1).not.toBeNull()
    expect(sesion2).not.toBeNull()
    expect(sesion1?.familyId).not.toBe(sesion2?.familyId)
  })

  it('guarda la IP y el User-Agent con la sesión', async () => {
    const resultado = await caso.ejecutar({
      email: 'ana@test.com',
      password: 'clave-correcta',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (prueba)',
    })

    // Cuando salte la detección de reuso hay que poder decir desde dónde nació
    // la familia; si estas columnas quedan a NULL, esa pregunta no tiene
    // respuesta posible.
    expect(sesiones.origenDe(resultado.refreshToken)).toEqual({
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (prueba)',
    })
  })

  it('deja el origen a null cuando el llamante no lo aporta', async () => {
    const resultado = await caso.ejecutar({ email: 'ana@test.com', password: 'clave-correcta' })

    expect(sesiones.origenDe(resultado.refreshToken)).toEqual({ ip: null, userAgent: null })
  })

  it('rechaza una contraseña incorrecta con CredencialesInvalidasError', async () => {
    await expect(caso.ejecutar({ email: 'ana@test.com', password: 'incorrecta' })).rejects.toThrow(
      CredencialesInvalidasError,
    )
  })

  it('rechaza un email que no existe con el MISMO error que una contraseña mala', async () => {
    await expect(
      caso.ejecutar({ email: 'nadie@test.com', password: 'lo-que-sea' }),
    ).rejects.toThrow(CredencialesInvalidasError)
  })

  it('verifica contra el hash señuelo cuando el email no existe (anti-enumeración)', async () => {
    await expect(
      caso.ejecutar({ email: 'nadie@test.com', password: 'lo-que-sea' }),
    ).rejects.toThrow(CredencialesInvalidasError)

    // La llamada a verify() ocurrió igual: el coste de Argon2 se paga tanto
    // si el usuario existe como si no, que es lo que igualo el tiempo.
    expect(hasher.llamadasAVerify).toBe(1)
  })
})
