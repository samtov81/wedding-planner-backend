import type { CursorPage, CursorValue } from '@/shared/domain'

import type { Marca, RolEnEvento } from '../domain/conversacion'
import type { EstadoDeSolicitud, ParDePerfil } from '../domain/perfil'

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
 * Lo que el contacto desde la ficha necesita de una ficha de proveedor (parte 3).
 * `publicada` = `status: 'PUBLISHED'`; `DRAFT` y `SUSPENDED` se tratan igual.
 */
export interface FichaParaContacto {
  id: string
  userId: string
  businessName: string
  publicada: boolean
}

/**
 * Una conversación `PROFILE` vista por uno de sus dos participantes (spec
 * 2026-11-03 §4.2). Nombres (§3.7): el proveedor es el `businessName` de la
 * ficha de la conversación con rol `VENDOR`; el solicitante, su `fullName` con
 * rol `CONTACT`, aunque él también tenga ficha.
 */
export interface ConversacionDePerfilVista {
  id: string
  status: EstadoDeSolicitud
  /** `SENT` si quien mira es el solicitante; `RECEIVED` si es el proveedor. */
  direction: 'SENT' | 'RECEIVED'
  other: { userId: string; displayName: string; role: 'VENDOR' | 'CONTACT' }
  vendor: { id: string; businessName: string }
  lastMessage: MensajeVista | null
  /** Mensajes del otro posteriores a MI marca de lectura (la regla de la 1:1). */
  unreadCount: number
  /** `status !== 'ACCEPTED'`: pendiente para los dos, rechazada para el solicitante. */
  readOnly: boolean
  /** Sólo una DECLINED vista por el solicitante: cuándo puede volver a pedir. */
  retryAt: Date | null
  otherMarks: MarcasDeParticipante
}

/**
 * Puerto de las conversaciones 1:1 de un evento, de la sala del evento (parte
 * 2) y de las conversaciones `PROFILE` del contacto desde la ficha (parte 3).
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
   * Los miembros de la sala HOY: las membresías ACTIVE de rol COUPLE/PLANNER
   * del evento (el mismo conjunto que cuenta `memberCount`; los proveedores
   * nunca), con o sin fila de participante, ordenados por nombre y luego id.
   * Distinto de `marcasDeSala`, que lista filas de participante (incluye a
   * quien salió y omite a quien aún no abrió la sala). [] si no es una sala.
   */
  miembrosDeSala(conversationId: string): Promise<Contacto[]>

  /**
   * El tipo de la conversación, sin mirar quién pregunta (null si no existe).
   * Lo usa el worker, que debe distinguir sala de 1:1 aunque el remitente ya
   * no la vea.
   */
  tipoDe(conversationId: string): Promise<'EVENT_DIRECT' | 'EVENT_ROOM' | 'PROFILE' | null>

  /** Destinatarios fijados de cada mensaje pedido (los que no tienen, ausentes). */
  destinatariosDe(messageIds: readonly string[]): Promise<Map<string, string[]>>

  // ── Contacto desde la ficha (parte 3) ─────────────────────────────────────

  /** La ficha, publicada o no; null si no existe. */
  fichaParaContacto(vendorProfileId: string): Promise<FichaParaContacto | null>

  /** La conversación `PROFILE` del par (sin orden), o null si no hay. */
  parDePerfil(a: string, b: string): Promise<ParDePerfil | null>

  /**
   * Podrían abrir hoy una `EVENT_DIRECT` entre sí en algún evento (reglas de la
   * parte 1 §4.1, las de `rolEnEvento`): los dos con acceso hoy al mismo
   * evento y no los dos como proveedores. Nunca VENDOR↔VENDOR.
   */
  tienenRelacion(a: string, b: string): Promise<boolean>

  /**
   * En una transacción, bloqueando la fila del par: evalúa con
   * `evaluarSolicitud` (lanza sus errores de dominio), crea la conversación o
   * la reintenta y añade el mensaje, que es la solicitud.
   */
  solicitar(e: {
    solicitante: string
    ficha: FichaParaContacto
    cuerpo: string
    relacionados: boolean
    ahora: Date
  }): Promise<{ conversationId: string; mensaje: MensajeVista }>

  /**
   * Acepta o rechaza. Sólo el proveedor (si no, o si no es `PROFILE`:
   * `no-encontrada`) y sólo en `PENDING` (si no: `no-pendiente`).
   */
  responder(
    conversationId: string,
    userId: string,
    decision: 'ACCEPTED' | 'DECLINED',
    ahora: Date,
  ): Promise<'ok' | 'no-encontrada' | 'no-pendiente'>

  /** null si no es `PROFILE` o `userId` no la ve (`veConversacionDePerfil`). */
  buscarPerfil(conversationId: string, userId: string): Promise<ConversacionDePerfilVista | null>

  /**
   * Las que ve `userId`, en el orden de `bandeja`. `requestsPending` = las
   * RECEIVED en PENDING; `unreadTotal` = suma de `unreadCount` de las ACCEPTED
   * (las pendientes ya cuentan en `requestsPending`).
   */
  perfiles(userId: string): Promise<{
    items: ConversacionDePerfilVista[]
    requestsPending: number
    unreadTotal: number
  }>
}

export const CONVERSATION_REPOSITORY = Symbol('CONVERSATION_REPOSITORY')
