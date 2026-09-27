import type { ObjectStorage, ObjetoAlmacenado } from '../application/object-storage.port'

/**
 * Almacén en memoria para tests. `simularSubida` hace lo que haría el
 * navegador con la URL prefirmada: dejar el objeto en el bucket.
 */
export class ObjectStorageEnMemoria implements ObjectStorage {
  readonly disponible = true
  readonly objetos = new Map<string, ObjetoAlmacenado>()
  readonly borradas: string[] = []

  firmarSubida(key: string, contentType: string, bytes: number): Promise<string> {
    return Promise.resolve(`https://almacen.test/put/${key}?ct=${contentType}&len=${bytes}`)
  }

  firmarLectura(key: string): Promise<string | null> {
    return Promise.resolve(`https://almacen.test/get/${key}`)
  }

  inspeccionar(key: string): Promise<ObjetoAlmacenado | null> {
    return Promise.resolve(this.objetos.get(key) ?? null)
  }

  borrar(key: string): Promise<void> {
    this.objetos.delete(key)
    this.borradas.push(key)
    return Promise.resolve()
  }

  simularSubida(key: string, contentType = 'image/jpeg', bytes = 1024): void {
    this.objetos.set(key, { contentType, bytes })
  }
}
