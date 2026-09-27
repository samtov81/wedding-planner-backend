export interface PasswordHasher {
  hash(plano: string): Promise<string>
  /** Devuelve `false` ante un hash corrupto; no lanza. */
  verify(hash: string, plano: string): Promise<boolean>
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER')
