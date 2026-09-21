export type ResultadoConsumo = 'CONSUMIDO' | 'YA_CONSUMIDO' | 'NO_ENCONTRADO_O_CADUCADO'

export interface ConsumoToken {
  resultado: ResultadoConsumo
  userId?: string
}

export interface EmailVerificationTokenRepository {
  crear(datos: { userId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }>
  caducarVigentesDe(userId: string, ahora: Date): Promise<void>
  consumirPorHash(tokenHash: string, ahora: Date): Promise<ConsumoToken>
}

export const EMAIL_VERIFICATION_TOKEN_REPOSITORY = Symbol('EMAIL_VERIFICATION_TOKEN_REPOSITORY')
