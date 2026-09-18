import { randomUUID } from 'node:crypto'

import type {
  DatosCrearInvitacion,
  InvitacionCompleta,
  InvitationRepository,
} from '../application/invitation.repository'
import type { InvitationStatus } from '../domain/invitation'

/**
 * Doble en memoria del puerto (ruling H1). No es más permisivo que el
 * adaptador de Prisma: `tokenHash` es ÚNICO en el esquema, así que crear dos
 * invitaciones con el mismo hash falla aquí igual que allí — si no, un test
 * podría dar verde sobre un estado que la base de datos jamás permitiría.
 */
export class InvitationRepositoryEnMemoria implements InvitationRepository {
  private readonly filas: InvitacionCompleta[] = []

  /**
   * Siembra una invitación ya existente. Los campos que el test no nombra se
   * rellenan con valores coherentes: sembrar una fila a medias sería una fila
   * que la base de datos no puede tener.
   */
  añadir(
    parcial: Partial<Omit<InvitacionCompleta, 'guest' | 'event'>> & {
      id: string
      guest?: Partial<InvitacionCompleta['guest']>
      event?: Partial<InvitacionCompleta['event']>
    },
  ): InvitacionCompleta {
    const fila: InvitacionCompleta = {
      id: parcial.id,
      status: parcial.status ?? 'QUEUED',
      expiresAt: parcial.expiresAt ?? new Date(Date.UTC(2027, 0, 1)),
      respondedAt: parcial.respondedAt ?? null,
      resendMessageId: parcial.resendMessageId ?? null,
      guest: {
        id: parcial.guest?.id ?? 'g1',
        eventId: parcial.guest?.eventId ?? 'ev-1',
        name: parcial.guest?.name ?? 'Ana Invitada',
        email: parcial.guest?.email === undefined ? 'invitada@test.com' : parcial.guest.email,
      },
      event: {
        id: parcial.event?.id ?? 'ev-1',
        name: parcial.event?.name ?? 'Boda de Ana',
        weddingDate: parcial.event?.weddingDate ?? new Date(Date.UTC(2027, 5, 12)),
      },
    }
    this.filas.push(fila)
    return fila
  }

  /** Vista de sólo lectura para assertar en los tests. */
  todas(): Array<InvitacionCompleta & { tokenHash: string }> {
    return this.filas.map((fila) => ({ ...fila, tokenHash: this.hashDe(fila.id) }))
  }

  private hashDe(id: string): string {
    for (const [hash, suyo] of this.idsPorHash) if (suyo === id) return hash
    return ''
  }

  buscar(id: string): InvitacionCompleta | undefined {
    return this.filas.find((fila) => fila.id === id)
  }

  /** Indexado por hash, como el `@unique` de la columna: dos iguales chocan. */
  private readonly idsPorHash = new Map<string, string>()

  crear(datos: DatosCrearInvitacion): Promise<{ id: string }> {
    if (this.idsPorHash.has(datos.tokenHash)) {
      // El `@unique` de `tokenHash` en el esquema, replicado: el doble no puede
      // aceptar lo que Postgres rechazaría.
      return Promise.reject(new Error('tokenHash duplicado'))
    }

    const fila = this.añadir({ id: randomUUID(), expiresAt: datos.expiresAt })
    fila.guest.id = datos.guestId
    this.idsPorHash.set(datos.tokenHash, fila.id)

    return Promise.resolve({ id: fila.id })
  }

  buscarConInvitadoYEvento(id: string): Promise<InvitacionCompleta | null> {
    const fila = this.buscar(id)
    return Promise.resolve(fila === undefined ? null : { ...fila })
  }

  marcarEnviada(id: string, providerMessageId: string): Promise<void> {
    const fila = this.buscar(id)
    if (fila !== undefined) {
      fila.status = 'SENT'
      fila.resendMessageId = providerMessageId
    }
    return Promise.resolve()
  }

  buscarPorHash(tokenHash: string): Promise<InvitacionCompleta | null> {
    const id = this.idsPorHash.get(tokenHash)
    return id === undefined ? Promise.resolve(null) : this.buscarConInvitadoYEvento(id)
  }

  marcarRespondida(id: string): Promise<void> {
    const fila = this.buscar(id)
    if (fila !== undefined) {
      fila.status = 'RESPONDED'
      fila.respondedAt = new Date()
    }
    return Promise.resolve()
  }

  actualizarEstadoPorMessageId(messageId: string, estado: InvitationStatus): Promise<void> {
    for (const fila of this.filas) {
      if (fila.resendMessageId === messageId) fila.status = estado
    }
    return Promise.resolve()
  }
}
