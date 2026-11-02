import type { CursorPage, CursorValue } from '@/shared/domain'

import type { Marca, RolEnEvento } from '../domain/conversacion'

/** Alguien con quien se puede hablar en un evento. */
export interface Contacto {
  userId: string
  /** `businessName` para un proveedor, `fullName` para un miembro. */
  displayName: string
  role: RolEnEvento
}

export interface MensajeVista {
  id: string
  conversationId: string
  senderId: string
  body: string
  createdAt: Date
}

export interface ConversacionVista {
  id: string
  event: { id: string; name: string }
  other: Contacto
  lastMessage: MensajeVista | null
  /** Mensajes del otro posteriores a MI marca de lectura. */
  unreadCount: number
  /** Alguno de los dos ya no tiene acceso al evento: se lee, no se escribe. */
  readOnly: boolean
  /** Las marcas del OTRO, para pintar "entregado" y "leído" en mis mensajes. */
  otherMarks: { deliveredUpTo: Marca | null; readUpTo: Marca | null }
}

export interface MarcasDeParticipante {
  deliveredUpTo: Marca | null
  readUpTo: Marca | null
}

/**
 * La sala del evento vista por un usuario (parte 2). Está en ella quien es
 * miembro ACTIVE hoy; un miembro que dejó de serlo y llegó a participar la ve
 * en solo lectura y SÓLO hasta que salió (`visibleHasta`). Proveedores, admins
 * sin membresía y quien nunca participó no la ven.
 */
export interface SalaVista {
  id: string
  event: { id: string; name: string }
  /** Miembros ACTIVE del evento hoy. */
  memberCount: number
  lastMessage: MensajeVista | null
  /** Mensajes en los que soy destinatario posteriores a MI marca de lectura. */
  unreadCount: number
  /** No soy miembro ACTIVE hoy: leo lo que había hasta que salí, no escribo. */
  readOnly: boolean
  /**
   * Sólo con `readOnly`: el último mensaje que puedo ver (el último en el que
   * fui remitente o destinatario); null = ninguno. Sin `readOnly`, null.
   */
  visibleHasta: Marca | null
}

/** Las marcas de un participante de la sala, con quién es, para "leído por". */
export interface MarcaDeMiembro extends MarcasDeParticipante {
  userId: string
  displayName: string
  role: 'COUPLE' | 'PLANNER'
}

/**
 * Puerto de las conversaciones 1:1 de un evento.
 *
 * "Acceso hoy" (spec §4): miembro ACTIVE (pareja o planner, el evento esté o
 * no publicado) o proveedor BOOKED —por `VendorProfile.userId`— de un evento
 * PUBLICADO (`status: 'ACTIVE'`). Un administrador del sistema no cuenta y un
 * INVITED tampoco. Se calcula en cada consulta, nunca se guarda: perder el
 * acceso cambia la conversación a solo lectura sin tocar ninguna fila.
 *
 * Visibilidad: es participante Y (tiene acceso hoy O es un miembro que lo
 * perdió, que la ve en solo lectura). Un proveedor que lo perdió no la ve.
 */
export interface ConversationRepository {
  /** Rol de `userId` en el evento si tiene acceso de mensajería hoy; null si no. */
  rolEnEvento(eventId: string, userId: string): Promise<RolEnEvento | null>

  /**
   * Con quién puede hablar `userId` en el evento: gente con acceso hoy, sin él
   * mismo y, si él es proveedor, sin otros proveedores. Vacío si él no tiene acceso.
   */
  contactos(eventId: string, userId: string): Promise<Contacto[]>

  /**
   * Crea la conversación del par o devuelve la que ya hay. `creada` deja que
   * REST conteste 201 o 200. Si dos peticiones chocan en el UNIQUE de `pairKey`,
   * la perdedora relee y devuelve la existente con `creada: false`; nunca falla.
   */
  abrir(eventId: string, a: string, b: string): Promise<{ id: string; creada: boolean }>

  /** null si no existe o `userId` no puede verla. */
  buscar(conversationId: string, userId: string): Promise<ConversacionVista | null>

  /** Las visibles de `userId`, por `lastMessageAt` desc (sin mensajes al final). */
  bandeja(userId: string): Promise<{ items: ConversacionVista[]; unreadTotal: number }>

  /**
   * Más recientes primero, orden total (createdAt, id). `hasta` es el tope de
   * quien lee la sala en solo lectura: sin él (undefined) no hay tope; con
   * null la página sale vacía (no puede ver ningún mensaje).
   */
  mensajes(
    conversationId: string,
    opciones: { desde: CursorValue | null; limite: number; hasta?: Marca | null | undefined },
  ): Promise<CursorPage<MensajeVista>>

  /** Guarda el mensaje y mueve `lastMessageAt` en la misma transacción. */
  agregarMensaje(
    conversationId: string,
    senderId: string,
    body: string,
    ahora: Date,
  ): Promise<MensajeVista>

  /** Un mensaje por id, acotado a su conversación; null si no existe ahí. */
  mensaje(conversationId: string, messageId: string): Promise<MensajeVista | null>

  /** Avanza la marca (nunca retrocede). false si `upTo` no es de la conversación. */
  marcar(
    conversationId: string,
    userId: string,
    tipo: 'delivered' | 'read',
    upTo: string,
  ): Promise<MarcasDeParticipante | false>

  participantes(conversationId: string): Promise<string[]>

  /**
   * Sala del evento (parte 2). Si `userId` es miembro ACTIVE, la crea si falta
   * y le asegura su fila de participante (idempotente y a prueba de choques,
   * como `abrir`); devuelve su id. Si no lo es, devuelve el id de la sala si ya
   * existe o null, sin crear nada. Decidir si la ve es cosa de `buscarSala`.
   */
  abrirSala(eventId: string, userId: string): Promise<string | null>

  /** null si no es una sala o `userId` no puede verla (ver `SalaVista`). */
  buscarSala(conversationId: string, userId: string): Promise<SalaVista | null>

  /**
   * Las salas de `userId`: la de cada evento donde es ACTIVE (creándola si
   * falta) y las de solo lectura de eventos de los que salió. Mismo orden que
   * `bandeja`. `unreadTotal` es sólo de las salas.
   */
  salas(userId: string): Promise<{ items: SalaVista[]; unreadTotal: number }>

  /**
   * Guarda un mensaje de sala y FIJA sus destinatarios (miembros ACTIVE del
   * evento en ese instante, sin el remitente) en la misma transacción, junto a
   * sus filas de participante y `lastMessageAt`.
   */
  agregarMensajeDeSala(
    conversationId: string,
    senderId: string,
    body: string,
    ahora: Date,
  ): Promise<{ mensaje: MensajeVista; destinatarios: string[] }>

  /** Las marcas de cada participante de la sala, con su nombre y su rol. */
  marcasDeSala(conversationId: string): Promise<MarcaDeMiembro[]>

  /**
   * El tipo de la conversación, sin mirar quién pregunta (null si no existe).
   * Lo usa el worker, que debe distinguir sala de 1:1 aunque el remitente ya
   * no la vea.
   */
  tipoDe(conversationId: string): Promise<'EVENT_DIRECT' | 'EVENT_ROOM' | null>

  /** Destinatarios fijados de cada mensaje pedido (los que no tienen, ausentes). */
  destinatariosDe(messageIds: readonly string[]): Promise<Map<string, string[]>>
}

export const CONVERSATION_REPOSITORY = Symbol('CONVERSATION_REPOSITORY')
