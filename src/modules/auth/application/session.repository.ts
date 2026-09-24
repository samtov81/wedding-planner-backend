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
  /**
   * La sesión VIVA (no revocada) de una familia, si la hay. La usa la
   * ventana de gracia de `RefreshUseCase`: cuando dos peticiones comparten el
   * mismo refresh (dos pestañas con la misma cookie, o una que perdió el
   * compare-and-swap de `rotar` por milisegundos), la perdedora no puede
   * reconstruir el token en claro de la sesión que ganó — sólo se guarda su
   * hash — así que en vez de "devolver los tokens de la sucesora" literal, se
   * la usa como punto de partida para una rotación más, produciendo tokens
   * NUEVOS y válidos para la petición perdedora sin matar la familia. Como
   * en cada instante sólo hay una sesión viva por familia salvo en el
   * brevísimo hueco entre el CAS y el insert de `rotar`, este método basta
   * para localizarla sin necesitar un enlace explícito padre→hijo en el
   * modelo.
   */
  buscarSesionVivaDeFamilia(familyId: string): Promise<SesionPersistida | null>
}

export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY')
