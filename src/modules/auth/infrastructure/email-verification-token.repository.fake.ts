import type {
  ConsumoToken,
  EmailVerificationTokenRepository,
} from '../application/email-verification-token.repository'

interface TokenData {
  id: string
  userId: string
  tokenHash: string
  status: 'PENDING' | 'CONSUMED'
  expiresAt: Date
  consumedAt: Date | null
}

export class EmailVerificationTokenRepositoryFake implements EmailVerificationTokenRepository {
  private tokens = new Map<string, TokenData>()
  private lastId = 0

  async crear(datos: { userId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }> {
    const id = `token-${++this.lastId}`
    if (this.tokens.has(datos.tokenHash)) {
      throw new Error(`Token hash ya existe: ${datos.tokenHash}`)
    }
    this.tokens.set(datos.tokenHash, {
      id,
      userId: datos.userId,
      tokenHash: datos.tokenHash,
      status: 'PENDING',
      expiresAt: datos.expiresAt,
      consumedAt: null,
    })
    return { id }
  }

  async caducarVigentesDe(userId: string, ahora: Date): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.userId === userId && token.status === 'PENDING' && token.expiresAt.getTime() > ahora.getTime()) {
        token.expiresAt = ahora
      }
    }
  }

  async consumirPorHash(tokenHash: string, ahora: Date): Promise<ConsumoToken> {
    const token = this.tokens.get(tokenHash)

    if (token === undefined) {
      return { resultado: 'NO_ENCONTRADO_O_CADUCADO' }
    }

    if (token.status === 'CONSUMED') {
      return { resultado: 'YA_CONSUMIDO', userId: token.userId }
    }

    if (token.expiresAt.getTime() <= ahora.getTime()) {
      return { resultado: 'NO_ENCONTRADO_O_CADUCADO' }
    }

    // Consumir
    token.status = 'CONSUMED'
    token.consumedAt = ahora
    return { resultado: 'CONSUMIDO', userId: token.userId }
  }

  // Test helper
  obtenerPorHash(tokenHash: string): TokenData | undefined {
    return this.tokens.get(tokenHash)
  }
}
