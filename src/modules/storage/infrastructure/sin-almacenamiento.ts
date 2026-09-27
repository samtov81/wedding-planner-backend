import { AlmacenamientoNoDisponibleError } from '../domain/imagen'
import type { ObjectStorage, ObjetoAlmacenado } from '../application/object-storage.port'

/** Sin R2 configurado: no hay dónde subir y lo guardado sale sin URL. */
export class SinAlmacenamiento implements ObjectStorage {
  readonly disponible = false

  firmarSubida(): Promise<string> {
    return Promise.reject(new AlmacenamientoNoDisponibleError())
  }

  firmarLectura(): Promise<string | null> {
    return Promise.resolve(null)
  }

  inspeccionar(): Promise<ObjetoAlmacenado | null> {
    return Promise.reject(new AlmacenamientoNoDisponibleError())
  }

  borrar(): Promise<void> {
    return Promise.resolve()
  }
}
