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

  /** Más recientes primero, orden total (createdAt, id). */
  mensajes(
    conversationId: string,
    opciones: { desde: CursorValue | null; limite: number },
  ): Promise<CursorPage<MensajeVista>>

  /** Guarda el mensaje y mueve `lastMessageAt` en la misma transacción. */
  agregarMensaje(
    conversationId: string,
    senderId: string,
    body: string,
    ahora: Date,
  ): Promise<MensajeVista>

  /** Avanza la marca (nunca retrocede). false si `upTo` no es de la conversación. */
  marcar(
    conversationId: string,
    userId: string,
    tipo: 'delivered' | 'read',
    upTo: string,
  ): Promise<MarcasDeParticipante | false>

  participantes(conversationId: string): Promise<string[]>
}

export const CONVERSATION_REPOSITORY = Symbol('CONVERSATION_REPOSITORY')
