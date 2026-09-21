import { randomUUID } from 'node:crypto'

import type {
  DatosCrearInvitacion,
  InvitacionAvanzada,
  InvitacionCompleta,
  InvitationRepository,
} from '../application/invitation.repository'
import { InvitadoNoEncontradoError } from '../domain/guest-errors'
import {
  admiteLectura,
  estadosQuePuedenAvanzarA,
  type InvitationStatus,
} from '../domain/invitation'

/**
 * Un invitado que el doble CONOCE: la fila de `guests` a la que apunta la clave
 * foránea de la invitación, con su evento. Sin esto, `crear` aceptaría un
 * `guestId` inventado que Postgres rechaza con `P2003`.
 */
interface InvitadoConocido {
  guest: InvitacionCompleta['guest']
  event: InvitacionCompleta['event']
}

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
   * que la base de datos no puede tener. Con `tokenHash`, la fila se encuentra
   * por `buscarPorHash` (el RSVP público); sin él, sólo por id.
   */
  añadir(
    parcial: Partial<Omit<InvitacionCompleta, 'guest' | 'event'>> & {
      id: string
      tokenHash?: string
      guest?: Partial<InvitacionCompleta['guest']>
      event?: Partial<InvitacionCompleta['event']>
    },
  ): InvitacionCompleta {
    if (parcial.tokenHash !== undefined) {
      // El `@unique` de `tokenHash`, también al sembrar.
      if (this.idsPorHash.has(parcial.tokenHash)) throw new Error('tokenHash duplicado')
      this.idsPorHash.set(parcial.tokenHash, parcial.id)
    }

    // Sembrar una invitación implica que su invitado existe: queda registrado
    // para que un `crear` posterior sobre él no se comporte como un `P2003`.
    const invitado = this.registrarInvitado({ ...parcial.guest, event: parcial.event })

    const fila: InvitacionCompleta = {
      id: parcial.id,
      status: parcial.status ?? 'QUEUED',
      expiresAt: parcial.expiresAt ?? new Date(Date.UTC(2027, 0, 1)),
      respondedAt: parcial.respondedAt ?? null,
      resendMessageId: parcial.resendMessageId ?? null,
      guest: { ...invitado.guest },
      event: { ...invitado.event },
    }
    this.filas.push(fila)
    return fila
  }

  /**
   * Da de alta al invitado (y a su evento) que el doble conoce, como la fila de
   * `guests` que Postgres exige para poder crear su invitación. Lo que el test
   * nombra gana; lo que no, lo hereda de lo ya registrado, y sólo si no había
   * nada se rellena con los valores por defecto. Así dos invitaciones del mismo
   * invitado comparten invitado y evento, como comparten fila en Postgres.
   */
  registrarInvitado(datos: {
    id?: string
    eventId?: string
    name?: string
    email?: string | null
    event?: Partial<InvitacionCompleta['event']> | undefined
  }): InvitadoConocido {
    const id = datos.id ?? 'g1'
    const previo = this.invitados.get(id)

    const guest: InvitacionCompleta['guest'] = {
      id,
      eventId: datos.eventId ?? previo?.guest.eventId ?? 'ev-1',
      name: datos.name ?? previo?.guest.name ?? 'Ana Invitada',
      // Sin `??`: un email `null` registrado es un dato, no un hueco.
      email:
        datos.email !== undefined
          ? datos.email
          : previo !== undefined
            ? previo.guest.email
            : 'invitada@test.com',
    }
    const invitado: InvitadoConocido = {
      guest,
      event: {
        // El evento ES el del invitado: en Postgres, `guests.eventId` apunta a
        // esta misma fila y no pueden discrepar.
        id: datos.event?.id ?? previo?.event.id ?? guest.eventId,
        name: datos.event?.name ?? previo?.event.name ?? 'Boda de Ana',
        // Relativa a hoy: con una fecha fija, todo test que respondiera sobre el
        // evento por defecto empezaría a dar RSVP_CLOSED al pasar su cierre.
        weddingDate:
          datos.event?.weddingDate ??
          previo?.event.weddingDate ??
          new Date(Date.now() + 180 * 86_400_000),
        // El `@default(14)` de la columna. Literal y no la constante de
        // `events/domain`: un módulo no importa el dominio de otro.
        rsvpDeadlineDays: datos.event?.rsvpDeadlineDays ?? previo?.event.rsvpDeadlineDays ?? 14,
      },
    }
    this.invitados.set(id, invitado)
    return invitado
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
  /** Los `guests` que existen, como las filas a las que apunta la clave foránea. */
  private readonly invitados = new Map<string, InvitadoConocido>()
  private readonly fallosAlCrear = new Map<string, Error>()
  private falloAlMarcar: Error | null = null

  /** Simula que el `create` de ESE invitado falla (p. ej. `P2003`, borrado a mitad). */
  fallarCrearPara(guestId: string, error: Error): void {
    this.fallosAlCrear.set(guestId, error)
  }

  /** Hace fallar SÓLO el siguiente `marcarEnviada`: la ventana tras un envío correcto. */
  fallarProximoMarcado(error: Error): void {
    this.falloAlMarcar = error
  }

  crear(datos: DatosCrearInvitacion): Promise<{ id: string }> {
    const fallo = this.fallosAlCrear.get(datos.guestId)
    if (fallo !== undefined) return Promise.reject(fallo)

    // La clave foránea del esquema: un invitado que no existe da `P2003`, y el
    // adaptador de Prisma lo traduce a este error. El doble no puede crear una
    // invitación colgando de nadie.
    const invitado = this.invitados.get(datos.guestId)
    if (invitado === undefined) return Promise.reject(new InvitadoNoEncontradoError())

    if (this.idsPorHash.has(datos.tokenHash)) {
      // El `@unique` de `tokenHash` en el esquema, replicado: el doble no puede
      // aceptar lo que Postgres rechazaría.
      return Promise.reject(new Error('tokenHash duplicado'))
    }

    // Con los datos del invitado REGISTRADO, no con los de por defecto: la fila
    // que devuelve `buscarConInvitadoYEvento` es la que el `include` de Prisma
    // traería, y el worker escribe a ese correo.
    const fila = this.añadir({
      id: randomUUID(),
      expiresAt: datos.expiresAt,
      tokenHash: datos.tokenHash,
      guest: invitado.guest,
      event: invitado.event,
    })

    return Promise.resolve({ id: fila.id })
  }

  buscarConInvitadoYEvento(id: string): Promise<InvitacionCompleta | null> {
    const fila = this.buscar(id)
    return Promise.resolve(fila === undefined ? null : { ...fila })
  }

  marcarEnviada(id: string, providerMessageId: string): Promise<void> {
    if (this.falloAlMarcar !== null) {
      const error = this.falloAlMarcar
      this.falloAlMarcar = null
      return Promise.reject(error)
    }
    // La MISMA guarda que el `WHERE` del adaptador de Prisma (ruling C21).
    const fila = this.buscar(id)
    if (fila !== undefined && estadosQuePuedenAvanzarA('SENT').includes(fila.status)) {
      fila.status = 'SENT'
      fila.resendMessageId = providerMessageId
    }
    return Promise.resolve()
  }

  buscarPorHash(tokenHash: string): Promise<InvitacionCompleta | null> {
    const id = this.idsPorHash.get(tokenHash)
    return id === undefined ? Promise.resolve(null) : this.buscarConInvitadoYEvento(id)
  }

  /**
   * La MISMA regla que el `WHERE` del adaptador de Prisma: token vivo a `ahora`,
   * en cualquier estado. El cierre NO se mira aquí, tampoco en Prisma.
   */
  marcarRespondida(id: string, ahora: Date): Promise<boolean> {
    const fila = this.buscar(id)
    if (fila === undefined || !admiteLectura(fila, ahora)) return Promise.resolve(false)
    fila.status = 'RESPONDED'
    fila.respondedAt = ahora
    return Promise.resolve(true)
  }

  caducar(id: string): Promise<void> {
    const fila = this.buscar(id)
    if (fila !== undefined) fila.expiresAt = new Date()
    return Promise.resolve()
  }

  /** La MISMA regla que el `WHERE` del adaptador de Prisma (ruling H1). */
  caducarVigentesDe(guestId: string, ahora: Date): Promise<void> {
    for (const fila of this.filas) {
      if (fila.guest.id === guestId && fila.expiresAt.getTime() > ahora.getTime()) {
        fila.expiresAt = ahora
      }
    }
    return Promise.resolve()
  }

  /**
   * La MISMA regla que el `WHERE` del adaptador de Prisma: sólo se avanza desde
   * un estado de rango menor. Un doble que sobrescribiera sin mirar daría verde
   * a un caso de uso que, contra Postgres, se comporta distinto (ruling H1).
   */
  actualizarEstadoPorMessageId(
    messageId: string,
    estado: InvitationStatus,
  ): Promise<InvitacionAvanzada[]> {
    const desde = estadosQuePuedenAvanzarA(estado)
    const avanzadas: InvitacionAvanzada[] = []
    for (const fila of this.filas) {
      if (fila.resendMessageId === messageId && desde.includes(fila.status)) {
        fila.status = estado
        avanzadas.push({
          invitationId: fila.id,
          guestId: fila.guest.id,
          eventId: fila.guest.eventId,
        })
      }
    }
    return Promise.resolve(avanzadas)
  }
}
