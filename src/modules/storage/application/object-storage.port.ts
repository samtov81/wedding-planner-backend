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
  /**
   * URL de GET de vida corta, o `null` sin almacenamiento. Con `descargarComo`
   * la URL fuerza la descarga con ese nombre de archivo.
   */
  firmarLectura(key: string, descargarComo?: string): Promise<string | null>
  /** Metadatos del objeto, o `null` si no existe. */
  inspeccionar(key: string): Promise<ObjetoAlmacenado | null>
  borrar(key: string): Promise<void>
  /**
   * Copia server-side `origen` a `destino` dentro del mismo bucket: los bytes
   * no pasan por el backend. Sin almacenamiento rechaza.
   */
  copiar(origen: string, destino: string): Promise<void>
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE')
