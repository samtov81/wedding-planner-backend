import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import type { ObjectStorage, ObjetoAlmacenado } from '../application/object-storage.port'

export interface ConfiguracionR2 {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

/** 5 minutos: lo justo para subir o para pintar la página que pidió la URL. */
const VIDA_DE_FIRMA_S = 300

/**
 * Cabecera `Content-Disposition` de una descarga con nombre (RFC 5987/6266).
 * `encodeURIComponent` deja sin escapar `' ( ) *`, que en `filename*` son
 * caracteres reservados: se escapan a mano para que un nombre como `a(1)'.pdf`
 * no rompa el valor de la cabecera.
 */
export function contentDispositionDe(nombre: string): string {
  const codificado = encodeURIComponent(nombre).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
  return `attachment; filename*=UTF-8''${codificado}`
}

export class R2ObjectStorage implements ObjectStorage {
  readonly disponible = true
  private readonly client: S3Client

  constructor(private readonly config: ConfiguracionR2) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    })
  }

  firmarSubida(key: string, contentType: string, bytes: number): Promise<string> {
    // `ContentType` y `ContentLength` entran en la firma: un PUT con otro tipo
    // u otro tamaño que el declarado lo rechaza R2, no este backend.
    const comando = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: bytes,
    })
    return getSignedUrl(this.client, comando, {
      expiresIn: VIDA_DE_FIRMA_S,
      signableHeaders: new Set(['content-type', 'content-length']),
    })
  }

  firmarLectura(key: string, descargarComo?: string): Promise<string | null> {
    const comando = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ...(descargarComo === undefined
        ? {}
        : {
            ResponseContentDisposition: contentDispositionDe(descargarComo),
          }),
    })
    return getSignedUrl(this.client, comando, { expiresIn: VIDA_DE_FIRMA_S })
  }

  async inspeccionar(key: string): Promise<ObjetoAlmacenado | null> {
    try {
      const cabecera = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      )
      return { contentType: cabecera.ContentType ?? null, bytes: cabecera.ContentLength ?? 0 }
    } catch (error) {
      if (error instanceof NotFound) return null
      throw error
    }
  }

  async borrar(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
  }
}
