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
  /** `rsvpDeadlineDays` fija el cierre del RSVP (`cierreRsvp`, bloque A §2). */
  event: { id: string; name: string; weddingDate: Date; rsvpDeadlineDays: number }
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
   * RESPONDED + `respondedAt = ahora`, SÓLO si el token sigue vivo
   * (`expiresAt > ahora`), comprobado en la MISMA escritura, y en CUALQUIER
   * estado: también sobre RESPONDED, porque el invitado puede cambiar su
   * respuesta hasta el cierre (bloque A §2). Devuelve si escribió.
   *
   * Es la única escritura que pone RESPONDED sobre RESPONDED; `marcarEnviada` y
   * el webhook siguen sin poder pisarlo (monotonía, bloque A §2).
   *
   * La guarda de la caducidad va en la escritura porque la caducidad SÍ tiene
   * escritores concurrentes: un reenvío o un cambio de email (`caducarVigentesDe`)
   * pueden matar el token entre la lectura del caso de uso y esta escritura. El
   * cierre, en cambio, se comprueba en la lectura (`admiteRespuesta`): sus dos
   * datos (`weddingDate`, `rsvpDeadlineDays`) no los escribe el flujo del RSVP,
   * así que no hay carrera propia que cerrar aquí.
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
   * `expiresAt = ahora` en TODAS las invitaciones del invitado que siguen
   * vigentes (`expiresAt > ahora`), en cualquier estado (ruling C24). Se llama
   * antes de crear una invitación nueva y cuando cambia el email del invitado:
   * así un invitado tiene como mucho UN token vivo, y el enlace que recibió una
   * dirección equivocada deja de abrir su RSVP.
   *
   * RESPONDED incluida: con el RSVP modificable (bloque A §2) un token ya
   * respondido sigue pudiendo cambiar la respuesta hasta el cierre, así que
   * también hay que matarlo. Si no, el enlace enviado a un email mal tecleado
   * seguiría pudiendo cambiar el RSVP del invitado real. Las ya caducadas no se
   * tocan: su `expiresAt` dice cuándo murieron.
   *
   * Escribe con el cliente de la transacción en curso, si la hay.
   */
  caducarVigentesDe(guestId: string, ahora: Date): Promise<void>

  /**
   * Lo usa el webhook del proveedor (Tarea 13), que casa por `resendMessageId`.
   *
   * Contrato: sólo AVANZA. Escribe `estado` únicamente en las filas cuyo estado
   * actual está en `estadosQuePuedenAvanzarA(estado)`, y lo comprueba en la
   * MISMA escritura (nada de leer y luego escribir). Un id que no casa, o una
   * fila que ya está igual o más adelante, afecta a 0 filas y NO lanza.
   *
   * Devuelve las filas que AVANZARON de verdad —las que cumplieron el `WHERE`
   * en esa misma escritura—, para que quien llama avise sólo de cambios reales
   * (Tarea 15: `guest.invitation.status`). Una lectura aparte, antes o
   * después, no sabría cuáles fueron con dos webhooks concurrentes.
   */
  actualizarEstadoPorMessageId(
    messageId: string,
    estado: InvitationStatus,
  ): Promise<InvitacionAvanzada[]>
}

/** Una invitación cuyo estado acaba de avanzar, con lo necesario para avisar a su evento. */
export interface InvitacionAvanzada {
  invitationId: string
  guestId: string
  eventId: string
}

export const INVITATION_REPOSITORY = Symbol('INVITATION_REPOSITORY')
