import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { RefreshInvalidoError, RefreshReutilizadoError } from '../domain/token-errors'
import { SessionRepositoryEnMemoria } from '../infrastructure/session.repository.fake'
import { RefreshUseCase } from './refresh.use-case'
import { TokenService } from './token.service'

describe('RefreshUseCase', () => {
  const tokens = new TokenService({
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    JWT_ACCESS_TTL: '15m',
    REFRESH_TTL_DAYS: 30,
  })
  let sesiones: SessionRepositoryEnMemoria
  let usuarios: UserRepositoryEnMemoria
  let caso: RefreshUseCase

  beforeEach(() => {
    sesiones = new SessionRepositoryEnMemoria()
    usuarios = new UserRepositoryEnMemoria([
      {
        id: 'user-1',
        email: 'a@test.com',
        fullName: 'A',
        systemRole: 'USER',
        emailVerifiedAt: null,
        passwordHash: 'irrelevante',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    caso = new RefreshUseCase(sesiones, usuarios, tokens)
  })

  async function emitirPrimero(): Promise<string> {
    const { token, hash } = tokens.generarRefresh()
    await sesiones.crear({
      userId: 'user-1',
      tokenHash: hash,
      familyId: 'familia-1',
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    return token
  }

  it('rota el refresh: devuelve uno nuevo y revoca el usado', async () => {
    const primero = await emitirPrimero()

    const resultado = await caso.ejecutar(primero)

    expect(resultado.refreshToken).not.toBe(primero)
    expect(resultado.accessToken).toMatch(/^eyJ/)
    expect(sesiones.estaRevocado(primero)).toBe(true)
  })

  it('detecta el reuso y revoca LA FAMILIA ENTERA', async () => {
    const primero = await emitirPrimero()
    const { refreshToken: segundo } = await caso.ejecutar(primero)

    // Presentar de nuevo el primero sólo puede significar que alguien lo robó:
    // el cliente legítimo ya tiene el segundo y nunca volvería al anterior.
    await expect(caso.ejecutar(primero)).rejects.toThrow(RefreshReutilizadoError)

    // Y el ladrón no puede seguir usando el que sí es válido.
    await expect(caso.ejecutar(segundo)).rejects.toThrow()
    expect(sesiones.familiaRevocada('familia-1')).toBe(true)
  })

  it('rechaza un refresh que no existe', async () => {
    await expect(caso.ejecutar('inventado')).rejects.toThrow(RefreshInvalidoError)
  })

  it('rechaza un refresh caducado', async () => {
    const { token, hash } = tokens.generarRefresh()
    await sesiones.crear({
      userId: 'user-1',
      tokenHash: hash,
      familyId: 'familia-1',
      expiresAt: new Date(Date.now() - 1_000),
    })

    await expect(caso.ejecutar(token)).rejects.toThrow(RefreshInvalidoError)
  })
})
