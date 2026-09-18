import type { InvitationStatus } from '../domain/invitation'

/**
 * La invitación con lo que el worker y el RSVP público necesitan para actuar:
 * a quién escribir y de qué boda. Es una LECTURA compuesta, no la fila cruda —
 * el worker no debe volver a consultar por su cuenta ni conocer el esquema.
 *
 * `guest.email` es `string | null` porque la columna lo es: el correo puede
 * borrarse entre el encolado y el procesado. El worker lo comprueba en vez de
 * confiar en que "sólo se encolan invitados con email".
 */
export interface InvitacionCompleta {
  id: string
  status: InvitationStatus
  expiresAt: Date
  respondedAt: Date | null
  resendMessageId: string | null
  guest: { id: string; eventId: string; name: string; email: string | null }
  event: { id: string; name: string; weddingDate: Date }
}

export interface DatosCrearInvitacion {
  guestId: string
  tokenHash: string
  expiresAt: Date
}

export interface InvitationRepository {
  /**
   * Persiste SÓLO el hash. El token en claro no entra ni sale de aquí: lo tiene
   * el caso de uso, que lo mete en el payload del job — la única copia.
   */
  crear(datos: DatosCrearInvitacion): Promise<{ id: string }>

  buscarConInvitadoYEvento(id: string): Promise<InvitacionCompleta | null>

  /**
   * SENT + `sentAt` + el id del proveedor, en UNA escritura (ver el worker).
   *
   * Sólo AVANZA (ruling C21): escribe únicamente si el estado actual está en
   * `estadosQuePuedenAvanzarA('SENT')`, comprobado en la MISMA escritura. Un
   * reintento del job que llega cuando el invitado ya respondió (o el webhook
   * ya dijo DELIVERED/BOUNCED) afecta a 0 filas y NO lanza: pisar `RESPONDED`
   * con `SENT` borraría la respuesta del invitado de la vista de la pareja.
   */
  marcarEnviada(id: string, providerMessageId: string): Promise<void>

  /** Entrada del RSVP público (Tarea 14): se busca por hash, nunca por token. */
  buscarPorHash(tokenHash: string): Promise<InvitacionCompleta | null>

  /**
   * RESPONDED + `respondedAt = ahora`, SÓLO si la invitación sigue admitiendo
   * respuesta (`admiteRespuesta`: sin caducar a `ahora` y en un estado que puede
   * avanzar a RESPONDED), comprobado en la MISMA escritura. Devuelve si la
   * reclamó.
   *
   * Es la guarda de verdad del token de un solo uso: el caso de uso ya leyó la
   * invitación válida, pero dos respuestas simultáneas con el mismo token leen
   * las dos "válida"; sólo una de las dos escrituras afecta a la fila.
   *
   * Se llama dentro de una `UnidadDeTrabajo`: el adaptador escribe con el
   * cliente de la transacción en curso.
   */
  marcarRespondida(id: string, ahora: Date): Promise<boolean>

  /**
   * `expiresAt = ahora`: el token deja de servir aunque siga en algún sitio (el
   * payload de un job fallido en Redis). No hay estado de fallo en
   * `InvitationStatus` y el esquema no se toca, así que la caducidad ES la
   * invalidación. No lanza si la invitación ya no existe.
   */
  caducar(id: string): Promise<void>

  /**
   * Lo usa el webhook del proveedor (Tarea 13), que casa por `resendMessageId`.
   *
   * Contrato: sólo AVANZA. Escribe `estado` únicamente en las filas cuyo estado
   * actual está en `estadosQuePuedenAvanzarA(estado)`, y lo comprueba en la
   * MISMA escritura (nada de leer y luego escribir). Un id que no casa, o una
   * fila que ya está igual o más adelante, afecta a 0 filas y NO lanza.
   */
  actualizarEstadoPorMessageId(messageId: string, estado: InvitationStatus): Promise<void>
}

export const INVITATION_REPOSITORY = Symbol('INVITATION_REPOSITORY')
