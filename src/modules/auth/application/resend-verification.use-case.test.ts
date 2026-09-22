import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { EmailVerificationTokenRepositoryFake } from '../infrastructure/email-verification-token.repository.fake'
import { hashToken } from './token.service'
import { ResendVerificationUseCase } from './resend-verification.use-case'

describe('ResendVerificationUseCase', () => {
  let usuarios: UserRepositoryEnMemoria
  let tokens: EmailVerificationTokenRepositoryFake
  let cola: InMemoryQueueAdapter
  let caso: ResendVerificationUseCase

  beforeEach(() => {
    usuarios = new UserRepositoryEnMemoria([
      {
        id: 'user-1',
        email: 'sinverificar@test.com',
        fullName: 'Sin Verificar',
        systemRole: 'USER',
        emailVerifiedAt: null,
        passwordHash: 'hash:x',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'user-2',
        email: 'verificada@test.com',
        fullName: 'Verificada',
        systemRole: 'USER',
        emailVerifiedAt: new Date('2026-01-01'),
        passwordHash: 'hash:x',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    tokens = new EmailVerificationTokenRepositoryFake()
    cola = new InMemoryQueueAdapter()
    caso = new ResendVerificationUseCase(usuarios, tokens, cola, {
      EMAIL_VERIFICATION_TTL_HOURS: 48,
    } as never)
  })

  it('encola un correo nuevo para una cuenta sin verificar', async () => {
    await caso.ejecutar({ email: 'sinverificar@test.com' })

    expect(cola.encolados).toHaveLength(1)
    const encolado = cola.encolados[0]
    expect(encolado?.nombre).toBe('send-verification-email')
    const datos = encolado?.datos as { tokenId: string; token: string; email: string }
    expect(datos.email).toBe('sinverificar@test.com')
    expect(encolado?.jobId).toBe(`verify-email-${datos.tokenId}`)
    expect(encolado?.opciones.removeOnComplete).toBe(true)
  })

  it('caduca los tokens vigentes antes de emitir el nuevo: sólo un enlace vivo', async () => {
    await caso.ejecutar({ email: 'sinverificar@test.com' })
    const primero = (cola.encolados[0]?.datos as { token: string }).token

    await caso.ejecutar({ email: 'sinverificar@test.com' })

    const consumo = await tokens.consumirPorHash(hashToken(primero), new Date())
    expect(consumo.resultado).toBe('NO_ENCONTRADO_O_CADUCADO')
  })

  it('no encola nada si la cuenta ya está verificada', async () => {
    await caso.ejecutar({ email: 'verificada@test.com' })
    expect(cola.encolados).toHaveLength(0)
  })

  it('no encola nada ni lanza si el email no existe', async () => {
    await expect(caso.ejecutar({ email: 'nadie@test.com' })).resolves.toBeUndefined()
    expect(cola.encolados).toHaveLength(0)
  })

  // Review Focus #5: sin normalizar, findByEmail no encuentra al usuario y el
  // reenvío falla en silencio — el usuario no recibe nada y nadie se entera.
  it('normaliza el email como hace el registro: mayúsculas y espacios', async () => {
    await caso.ejecutar({ email: '  SinVerificar@Test.com  ' })
    expect(cola.encolados).toHaveLength(1)
  })
})
