export interface SesionPersistida {
  id: string
  userId: string
  familyId: string
  expiresAt: Date
  revokedAt: Date | null
}

export interface DatosNuevaSesion {
  userId: string
  tokenHash: string
  familyId: string
  expiresAt: Date
  /** IP de origen del login. `null` cuando el transporte no la expone. */
  ip?: string | null
  /** User-Agent de origen del login. `null` si la petición no lo manda. */
  userAgent?: string | null
}

export interface SessionRepository {
  crear(datos: DatosNuevaSesion): Promise<void>
  buscarPorHash(tokenHash: string): Promise<SesionPersistida | null>
  /**
   * Revocar la sesión usada y crear su hija, ATÓMICAMENTE. Devuelve `false`
   * si el compare-and-swap de la revocación no ganó — en ese caso no se crea
   * ninguna hija y el llamante debe tratarlo como reuso.
   *
   * Existe como una sola operación del puerto porque `application/` no puede
   * abrir una transacción de Prisma sin importar el adaptador: partirla en
   * revocar + `crear` deja al usuario sin sesión y sin recuperación si la
   * segunda falla.
   */
  rotar(datos: { sesionARevocar: string; nueva: DatosNuevaSesion }): Promise<boolean>
  /**
   * Revoca todas las sesiones vivas de la familia. Se serializa con `rotar`
   * de la misma familia: ninguna hija de una rotación concurrente sobrevive.
   */
  revocarFamilia(familyId: string): Promise<void>
}

export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY')
