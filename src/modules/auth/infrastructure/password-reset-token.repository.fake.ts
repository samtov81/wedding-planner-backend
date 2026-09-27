import type {
  PasswordResetTokenRepository,
  TokenResetConsumido,
} from '../application/password-reset-token.repository'

interface TokenData {
  id: string
  userId: string
  tokenHash: string
  status: 'PENDING' | 'CONSUMED'
  expiresAt: Date
  consumedAt: Date | null
}

/**
 * Doble en memoria. Su paridad con Prisma la fija
 * `password-reset-token.repository.paridad.test.ts` (ruling H1).
 */
export class PasswordResetTokenRepositoryFake implements PasswordResetTokenRepository {
  private tokens = new Map<string, TokenData>()
  private lastId = 0

  crear(datos: { userId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }> {
    // En Postgres `tokenHash` es UNIQUE: el doble tiene que fallar igual.
    if (this.tokens.has(datos.tokenHash)) {
      return Promise.reject(new Error(`Token hash ya existe: ${datos.tokenHash}`))
    }
    const id = `reset-${++this.lastId}`
    this.tokens.set(datos.tokenHash, { id, ...datos, status: 'PENDING', consumedAt: null })
    return Promise.resolve({ id })
  }

  caducarVigentesDe(userId: string, ahora: Date): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.userId === userId && token.status === 'PENDING' && token.expiresAt > ahora) {
        token.expiresAt = ahora
      }
    }
    return Promise.resolve()
  }

  consumirPorHash(tokenHash: string, ahora: Date): Promise<TokenResetConsumido | null> {
    const token = this.tokens.get(tokenHash)
    // Borde exclusivo, igual que el `expiresAt > ahora` del adaptador Prisma.
    if (token?.status !== 'PENDING' || token.expiresAt.getTime() <= ahora.getTime()) {
      return Promise.resolve(null)
    }
    token.status = 'CONSUMED'
    token.consumedAt = ahora
    return Promise.resolve({ userId: token.userId, tokenId: token.id })
  }
}
