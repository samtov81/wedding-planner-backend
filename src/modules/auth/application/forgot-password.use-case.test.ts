import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { PasswordResetTokenRepositoryFake } from '../infrastructure/password-reset-token.repository.fake'
import { ForgotPasswordUseCase } from './forgot-password.use-case'
import { hashToken } from './token.service'

/** El trabajo corre sin `await` (ver el docblock del caso de uso). */
const dejarCorrerSegundoPlano = () => new Promise((resolver) => setTimeout(resolver, 0))

function usuario(id: string, email: string, emailVerifiedAt: Date | null) {
  return {
    id,
    email,
    fullName: 'Nombre',
    systemRole: 'USER' as const,
    emailVerifiedAt,
    passwordHash: 'hash:x',
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

describe('ForgotPasswordUseCase', () => {
  let tokens: PasswordResetTokenRepositoryFake
  let cola: InMemoryQueueAdapter
  let caso: ForgotPasswordUseCase

  beforeEach(() => {
    const usuarios = new UserRepositoryEnMemoria([
      usuario('u-verif', 'verificada@test.com', new Date('2026-01-01')),
      usuario('u-pend', 'pendiente@test.com', null),
    ])
    tokens = new PasswordResetTokenRepositoryFake()
    cola = new InMemoryQueueAdapter()
    caso = new ForgotPasswordUseCase(usuarios, tokens, cola, { PASSWORD_RESET_TTL_MINUTES: 30 } as never)
  })

  it('encola el correo con el token en claro para una cuenta verificada', async () => {
    await caso.ejecutar({ email: 'verificada@test.com' })
    await dejarCorrerSegundoPlano()

    expect(cola.encolados).toHaveLength(1)
    const encolado = cola.encolados[0]
    const datos = encolado?.datos as { tokenId: string; token: string; email: string; userId: string }
    expect(encolado?.cola).toBe('email')
    expect(encolado?.nombre).toBe('send-password-reset-email')
    expect(datos.email).toBe('verificada@test.com')
    expect(datos.userId).toBe('u-verif')
    expect(encolado?.jobId).toBe(`password-reset-${datos.tokenId}`)
    expect(encolado?.opciones.removeOnComplete).toBe(true)
    // No es cota dura (ver el docblock de `removeOnFailAfterMs`): el control
    // real es la caducidad del token. Aquí sólo se fija al valor del TTL.
    expect(encolado?.opciones.removeOnFailAfterMs).toBe(30 * 60_000)
    // Lo que se guardó es el hash del token que viaja en el correo.
    expect(await tokens.consumirPorHash(hashToken(datos.token), new Date())).not.toBeNull()
  })

  it('también encola para una cuenta SIN verificar (el reset la verificará)', async () => {
    await caso.ejecutar({ email: 'pendiente@test.com' })
    await dejarCorrerSegundoPlano()

    expect(cola.encolados).toHaveLength(1)
  })

  it('normaliza el correo antes de buscar', async () => {
    await caso.ejecutar({ email: '  Verificada@TEST.com ' })
    await dejarCorrerSegundoPlano()

    expect(cola.encolados).toHaveLength(1)
  })

  it('no encola nada ni lanza si el email no existe', async () => {
    await expect(caso.ejecutar({ email: 'nadie@test.com' })).resolves.toBeUndefined()
    await dejarCorrerSegundoPlano()

    expect(cola.encolados).toHaveLength(0)
  })

  it('un segundo pedido caduca el enlace anterior: sólo uno vivo', async () => {
    await caso.ejecutar({ email: 'verificada@test.com' })
    await dejarCorrerSegundoPlano()
    const primero = (cola.encolados[0]?.datos as { token: string }).token

    await caso.ejecutar({ email: 'verificada@test.com' })
    await dejarCorrerSegundoPlano()

    expect(await tokens.consumirPorHash(hashToken(primero), new Date())).toBeNull()
  })

  it('un fallo del trabajo en segundo plano no rechaza la promesa', async () => {
    const { Logger } = await import('@nestjs/common')
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    vi.spyOn(tokens, 'crear').mockRejectedValue(new Error('BD caída'))

    await expect(caso.ejecutar({ email: 'verificada@test.com' })).resolves.toBeUndefined()
    await dejarCorrerSegundoPlano()

    expect(cola.encolados).toHaveLength(0)
  })
})
