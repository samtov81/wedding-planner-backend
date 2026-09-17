export interface SesionPersistida {
  id: string
  userId: string
  familyId: string
  expiresAt: Date
  revokedAt: Date | null
}

export interface SessionRepository {
  crear(datos: {
    userId: string
    tokenHash: string
    familyId: string
    expiresAt: Date
  }): Promise<void>
  buscarPorHash(tokenHash: string): Promise<SesionPersistida | null>
  revocar(id: string): Promise<void>
  revocarFamilia(familyId: string): Promise<void>
}

export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY')
