export interface TokenResetConsumido {
  userId: string
  tokenId: string
}

export interface PasswordResetTokenRepository {
  crear(datos: { userId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }>
  /** Caduca (`expiresAt = ahora`) los PENDING vigentes del usuario. */
  caducarVigentesDe(userId: string, ahora: Date): Promise<void>
  /**
   * Compare-and-swap PENDING→CONSUMED si `expiresAt > ahora`. `null` si no
   * existe, ya se usó o caducó: para el llamante son el mismo caso.
   */
  consumirPorHash(tokenHash: string, ahora: Date): Promise<TokenResetConsumido | null>
}

export const PASSWORD_RESET_TOKEN_REPOSITORY = Symbol('PASSWORD_RESET_TOKEN_REPOSITORY')
