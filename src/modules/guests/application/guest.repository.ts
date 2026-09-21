import type { CursorPage, CursorValue } from '@/shared/domain'

import type { Guest, RsvpStatus } from '../domain/guest'

/**
 * Los tres filtros son opcionales y se combinan con AND. `q` busca en nombre
 * y correo sin distinguir mayúsculas; el adaptador la construye con la API de
 * Prisma, NUNCA concatenando SQL (`$queryRawUnsafe` está prohibido por ESLint
 * justo por este caso).
 *
 * `| undefined` explícito en cada campo: con `exactOptionalPropertyTypes`, un
 * `rsvp?: RsvpStatus` no acepta que le pasen `undefined` a mano, y el borde
 * HTTP hace exactamente eso cuando el parámetro no viene.
 */
export interface GuestFilters {
  rsvp?: RsvpStatus | undefined
  group?: string | undefined
  q?: string | undefined
}

export interface DatosCrearInvitado {
  eventId: string
  name: string
  email: string | null
  group: string
  dietary: string | null
}

export interface CambiosInvitado {
  name?: string | undefined
  email?: string | null | undefined
  group?: string | undefined
  rsvp?: RsvpStatus | undefined
  dietary?: string | null | undefined
}

export interface GuestRepository {
  /** Página por cursor sobre la tupla (createdAt, id). Ver `PrismaGuestRepository`. */
  listar(
    eventId: string,
    filtros: GuestFilters,
    cursor: CursorValue | null,
    limite: number,
  ): Promise<CursorPage<Guest>>

  /** GROUP BY por estado. Siempre trae los tres estados, con 0 si no hay filas. */
  contarPorEstado(eventId: string): Promise<Record<RsvpStatus, number>>

  /** Lanza `EmailDuplicadoError` si el correo ya está invitado a este evento. */
  crear(datos: DatosCrearInvitado): Promise<Guest>

  /** `null` si no existe O si existe pero pertenece a otro evento. */
  buscar(eventId: string, guestId: string): Promise<Guest | null>

  actualizar(eventId: string, guestId: string, cambios: CambiosInvitado): Promise<Guest>

  borrar(eventId: string, guestId: string): Promise<void>

  /**
   * El evento ENTERO, sin paginar. Lo consume el envío masivo (Tarea 12), que
   * necesita la lista completa para encolar; no es para servirla por HTTP —
   * ahí está `listar`, con su tope de página.
   */
  listarTodos(eventId: string): Promise<Guest[]>
}

export const GUEST_REPOSITORY = Symbol('GUEST_REPOSITORY')
