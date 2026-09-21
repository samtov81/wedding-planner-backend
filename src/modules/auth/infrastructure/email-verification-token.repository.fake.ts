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

/**
 * Doble en memoria para los tests de `RegisterUseCase` y `VerifyEmailUseCase`.
 * Su paridad con el adaptador de Prisma se comprueba en
 * `email-verification-token.repository.paridad.test.ts` (ruling H1): un doble
 * más permisivo que Postgres daría verdes que producción desmiente.
 */
export class EmailVerificationTokenRepositoryFake implements EmailVerificationTokenRepository {
  private tokens = new Map<string, TokenData>()
  private lastId = 0

  crear(datos: { userId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }> {
    const id = `token-${++this.lastId}`
    // En Postgres `tokenHash` es UNIQUE: el doble tiene que fallar igual.
    if (this.tokens.has(datos.tokenHash)) {
      return Promise.reject(new Error(`Token hash ya existe: ${datos.tokenHash}`))
    }
    this.tokens.set(datos.tokenHash, {
      id,
      userId: datos.userId,
      tokenHash: datos.tokenHash,
      status: 'PENDING',
      expiresAt: datos.expiresAt,
      consumedAt: null,
    })
    return Promise.resolve({ id })
  }

  caducarVigentesDe(userId: string, ahora: Date): Promise<void> {
    for (const token of this.tokens.values()) {
      if (
        token.userId === userId &&
        token.status === 'PENDING' &&
        token.expiresAt.getTime() > ahora.getTime()
      ) {
        token.expiresAt = ahora
      }
    }
    return Promise.resolve()
  }

  consumirPorHash(tokenHash: string, ahora: Date): Promise<ConsumoToken> {
    const token = this.tokens.get(tokenHash)

    // eslint-disable-next-line security/detect-possible-timing-attacks -- no se compara un secreto: sólo se mira si el Map trajo fila o no
    if (token === undefined) {
      return Promise.resolve({ resultado: 'NO_ENCONTRADO_O_CADUCADO' })
    }

    if (token.status === 'CONSUMED') {
      return Promise.resolve({ resultado: 'YA_CONSUMIDO', userId: token.userId })
    }

    // Borde exclusivo, igual que el `expiresAt > $ahora` del adaptador Prisma.
    if (token.expiresAt.getTime() <= ahora.getTime()) {
      return Promise.resolve({ resultado: 'NO_ENCONTRADO_O_CADUCADO' })
    }

    token.status = 'CONSUMED'
    token.consumedAt = ahora
    return Promise.resolve({ resultado: 'CONSUMIDO', userId: token.userId })
  }

  /** Sólo para tests: deja assertar QUÉ se persistió sin pasar por el puerto. */
  obtenerPorHash(tokenHash: string): TokenData | undefined {
    return this.tokens.get(tokenHash)
  }
}
