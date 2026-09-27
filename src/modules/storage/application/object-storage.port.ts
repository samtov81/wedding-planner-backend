export interface ObjetoAlmacenado {
  contentType: string | null
  bytes: number
}

/**
 * Almacén de objetos (R2 vía API S3). El navegador sube y descarga directo con
 * URLs prefirmadas: los bytes nunca pasan por el backend.
 */
export interface ObjectStorage {
  /** `false` sin R2 configurado. */
  readonly disponible: boolean
  /** URL de PUT que sólo acepta exactamente ese `Content-Type` y ese tamaño. */
  firmarSubida(key: string, contentType: string, bytes: number): Promise<string>
  /** URL de GET de vida corta, o `null` sin almacenamiento. */
  firmarLectura(key: string): Promise<string | null>
  /** Metadatos del objeto, o `null` si no existe. */
  inspeccionar(key: string): Promise<ObjetoAlmacenado | null>
  borrar(key: string): Promise<void>
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE')
