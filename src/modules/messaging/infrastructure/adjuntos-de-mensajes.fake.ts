import type { AdjuntoVisible, AdjuntosDeMensajes } from '../application/adjuntos-de-mensajes.port'

/**
 * Doble del puerto público `ADJUNTOS_DE_MENSAJES` para los tests de otros
 * módulos (presupuesto). No reproduce la regla de visibilidad: el test dice
 * qué adjunto ve cada usuario con `poner`, y lo que no se puso es `null`.
 */
export class AdjuntosDeMensajesEnMemoria implements AdjuntosDeMensajes {
  private readonly visibles = new Map<string, AdjuntoVisible>()

  poner(userId: string, adjunto: AdjuntoVisible): void {
    this.visibles.set(`${userId}:${adjunto.messageId}`, { ...adjunto })
  }

  buscarVisible(userId: string, messageId: string): Promise<AdjuntoVisible | null> {
    const adjunto = this.visibles.get(`${userId}:${messageId}`)
    return Promise.resolve(adjunto === undefined ? null : { ...adjunto })
  }
}
