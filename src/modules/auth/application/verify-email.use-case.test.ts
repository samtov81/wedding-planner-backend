import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { EmailVerificationTokenRepositoryFake } from '../infrastructure/email-verification-token.repository.fake'
import { hashToken } from './token.service'
import { VerifyEmailUseCase } from './verify-email.use-case'

describe('VerifyEmailUseCase', () => {
  let usuarios: UserRepositoryEnMemoria
  let tokens: EmailVerificationTokenRepositoryFake
  let caso: VerifyEmailUseCase
  let userId: string

  const MAÑANA = (): Date => new Date(Date.now() + 86_400_000)
  const AYER = (): Date => new Date(Date.now() - 86_400_000)

  /** Crea el token como lo hace `RegisterUseCase`: persiste el hash, devuelve el claro. */
  async function emitirToken(enClaro: string, expiresAt = MAÑANA()): Promise<void> {
    await tokens.crear({ userId, tokenHash: hashToken(enClaro), expiresAt })
  }

  beforeEach(async () => {
    usuarios = new UserRepositoryEnMemoria()
    tokens = new EmailVerificationTokenRepositoryFake()
    caso = new VerifyEmailUseCase(tokens, usuarios)
    const usuario = await usuarios.create({
      email: 'ana@test.com',
      passwordHash: 'hash',
      fullName: 'Ana',
    })
    userId = usuario.id
  })

  it('con un token vigente devuelve `verified` y deja el email marcado', async () => {
    await emitirToken('token-bueno')

    expect(await caso.ejecutar('token-bueno')).toEqual({ outcome: 'verified' })
    // `marcarEmailVerificado` llevaba desde la Tarea 8 sin un solo llamador
    // real: éste es el primero, y por eso se comprueba el efecto, no la llamada.
    expect((await usuarios.findById(userId))?.emailVerifiedAt).not.toBeNull()
  })

  it('el segundo clic en el mismo enlace devuelve `already_verified`, no un error', async () => {
    await emitirToken('token-bueno')
    await caso.ejecutar('token-bueno')

    // Es lo que hace trivial el frontend: un `switch` sobre `outcome`, sin
    // rama de excepción. Un prefetch del cliente de correo cae justo aquí.
    expect(await caso.ejecutar('token-bueno')).toEqual({ outcome: 'already_verified' })
  })

  it('un token inventado devuelve `invalid_or_expired` en vez de lanzar', async () => {
    expect(await caso.ejecutar('esto-no-es-un-token')).toEqual({ outcome: 'invalid_or_expired' })
  })

  it('un token caducado devuelve `invalid_or_expired` y NO marca el email', async () => {
    await emitirToken('token-viejo', AYER())

    expect(await caso.ejecutar('token-viejo')).toEqual({ outcome: 'invalid_or_expired' })
    expect((await usuarios.findById(userId))?.emailVerifiedAt).toBeNull()
  })

  it('un token inválido deja el email sin verificar', async () => {
    await caso.ejecutar('basura')

    expect((await usuarios.findById(userId))?.emailVerifiedAt).toBeNull()
  })

  it('lo que se busca es el HASH del token, no el token: la tabla nunca ve el claro', async () => {
    await emitirToken('token-bueno')

    // Presentar el hash como si fuera el token no vale: se volvería a hashear.
    // Es lo que impide que un volcado de la tabla sirva para verificar cuentas.
    expect(await caso.ejecutar(hashToken('token-bueno'))).toEqual({
      outcome: 'invalid_or_expired',
    })
    expect(await caso.ejecutar('token-bueno')).toEqual({ outcome: 'verified' })
  })

  it('el token de una cuenta no verifica la de otra', async () => {
    const otra = await usuarios.create({
      email: 'luis@test.com',
      passwordHash: 'hash',
      fullName: 'Luis',
    })
    await tokens.crear({
      userId: otra.id,
      tokenHash: hashToken('token-de-luis'),
      expiresAt: MAÑANA(),
    })

    await caso.ejecutar('token-de-luis')

    expect((await usuarios.findById(otra.id))?.emailVerifiedAt).not.toBeNull()
    expect((await usuarios.findById(userId))?.emailVerifiedAt).toBeNull()
  })
})
