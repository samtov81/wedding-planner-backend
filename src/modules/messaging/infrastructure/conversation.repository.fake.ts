import { randomUUID } from 'node:crypto'

import { encodeCursor, type CursorPage, type CursorValue } from '@/shared/domain'

import type {
  Contacto,
  ConversacionVista,
  ConversationRepository,
  MarcasDeParticipante,
  MensajeVista,
} from '../application/conversation.repository'
import { avanzar, claveDePar, type Marca, type RolEnEvento } from '../domain/conversacion'
import { ParNoPermitidoError } from '../domain/messaging-errors'

interface MiembroEnMemoria {
  eventId: string
  userId: string
  role: 'COUPLE' | 'PLANNER'
  status: 'ACTIVE' | 'INVITED' | 'REVOKED'
  fullName: string
}

interface ProveedorEnMemoria {
  eventId: string
  userId: string
  businessName: string
  booked: boolean
}

interface ParticipanteEnMemoria {
  userId: string
  delivered: Marca | null
  read: Marca | null
}

interface ConversacionEnMemoria {
  id: string
  eventId: string
  pairKey: string
  createdAt: Date
  lastMessageAt: Date | null
  participantes: ParticipanteEnMemoria[]
}

/** Orden total (createdAt, id), más reciente primero. */
const masReciente = (x: MensajeVista, y: MensajeVista): number =>
  y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1)

/**
 * Doble en memoria de `ConversationRepository` (ruling H1). No es más
 * permisivo que el de Prisma: el acceso "hoy" (miembro ACTIVE, o proveedor
 * BOOKED de un evento publicado), la visibilidad (un miembro que perdió el
 * acceso la ve en solo lectura, un proveedor no), el orden y las marcas que
 * sólo avanzan se calculan igual. Lo comprueba `conversation.repository.paridad.test.ts`.
 */
export class ConversationRepositoryEnMemoria implements ConversationRepository {
  private readonly conversaciones: ConversacionEnMemoria[] = []
  private readonly mensajesGuardados: MensajeVista[] = []
  private readonly miembros: MiembroEnMemoria[] = []
  private readonly proveedores: ProveedorEnMemoria[] = []
  private readonly eventos = new Map<string, string>()
  private readonly publicados = new Set<string>()

  /** Alta o cambio de la membresía de `userId` (un solo registro por evento y persona). */
  registrarMiembro(
    eventId: string,
    userId: string,
    role: 'COUPLE' | 'PLANNER',
    status: 'ACTIVE' | 'INVITED' | 'REVOKED',
    fullName: string,
  ): void {
    const i = this.miembros.findIndex((m) => m.eventId === eventId && m.userId === userId)
    const nuevo = { eventId, userId, role, status, fullName }
    if (i === -1) this.miembros.push(nuevo)
    else this.miembros[i] = nuevo
  }

  /** `booked: false` equivale a una contratación cancelada o sólo preseleccionada. */
  registrarProveedor(eventId: string, userId: string, businessName: string, booked: boolean): void {
    const i = this.proveedores.findIndex((p) => p.eventId === eventId && p.userId === userId)
    const nuevo = { eventId, userId, businessName, booked }
    if (i === -1) this.proveedores.push(nuevo)
    else this.proveedores[i] = nuevo
  }

  /** Publica (`true`) o devuelve a borrador (`false`) el evento, como `Event.status`. */
  fijarPublicado(eventId: string, publicado: boolean): void {
    if (publicado) this.publicados.add(eventId)
    else this.publicados.delete(eventId)
  }

  registrarEvento(eventId: string, name: string): void {
    this.eventos.set(eventId, name)
  }

  rolEnEvento(eventId: string, userId: string): Promise<RolEnEvento | null> {
    return Promise.resolve(this.rolHoy(eventId, userId))
  }

  contactos(eventId: string, userId: string): Promise<Contacto[]> {
    const miRol = this.rolHoy(eventId, userId)
    if (miRol === null) return Promise.resolve([])

    const contactos: Contacto[] = this.miembros
      .filter((m) => m.eventId === eventId && m.status === 'ACTIVE' && m.userId !== userId)
      .map((m) => ({ userId: m.userId, displayName: m.fullName, role: m.role }))
    if (miRol !== 'VENDOR') {
      for (const p of this.proveedores) {
        if (p.eventId !== eventId || p.userId === userId || !p.booked) continue
        if (!this.publicados.has(eventId)) continue
        if (contactos.some((c) => c.userId === p.userId)) continue
        contactos.push({ userId: p.userId, displayName: p.businessName, role: 'VENDOR' })
      }
    }
    return Promise.resolve(contactos)
  }

  abrir(eventId: string, a: string, b: string): Promise<{ id: string; creada: boolean }> {
    if (a === b) return Promise.reject(new ParNoPermitidoError())
    const pairKey = claveDePar(eventId, a, b)
    const existente = this.conversaciones.find((c) => c.pairKey === pairKey)
    if (existente !== undefined) return Promise.resolve({ id: existente.id, creada: false })

    const nueva: ConversacionEnMemoria = {
      id: randomUUID(),
      eventId,
      pairKey,
      createdAt: new Date(),
      lastMessageAt: null,
      participantes: [a, b].map((userId) => ({ userId, delivered: null, read: null })),
    }
    this.conversaciones.push(nueva)
    return Promise.resolve({ id: nueva.id, creada: true })
  }

  buscar(conversationId: string, userId: string): Promise<ConversacionVista | null> {
    const conv = this.conversaciones.find((c) => c.id === conversationId)
    return Promise.resolve(conv === undefined ? null : this.vista(conv, userId))
  }

  bandeja(userId: string): Promise<{ items: ConversacionVista[]; unreadTotal: number }> {
    const propias = this.conversaciones.filter((c) =>
      c.participantes.some((p) => p.userId === userId),
    )
    const ordenadas = [...propias].sort((x, y) => {
      const tx = x.lastMessageAt?.getTime() ?? Number.NEGATIVE_INFINITY
      const ty = y.lastMessageAt?.getTime() ?? Number.NEGATIVE_INFINITY
      if (tx !== ty) return ty - tx
      return y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1)
    })
    const items = ordenadas.flatMap((c) => {
      const v = this.vista(c, userId)
      return v === null ? [] : [v]
    })
    return Promise.resolve({ items, unreadTotal: items.reduce((s, v) => s + v.unreadCount, 0) })
  }

  mensajes(
    conversationId: string,
    { desde, limite }: { desde: CursorValue | null; limite: number },
  ): Promise<CursorPage<MensajeVista>> {
    const ordenados = this.mensajesGuardados
      .filter((m) => m.conversationId === conversationId)
      .filter(
        (m) =>
          desde === null ||
          m.createdAt < desde.createdAt ||
          (m.createdAt.getTime() === desde.createdAt.getTime() && m.id < desde.id),
      )
      .sort(masReciente)
    const pagina = ordenados.slice(0, limite)
    const ultimo = pagina.at(-1)
    return Promise.resolve({
      items: pagina.map((m) => ({ ...m })),
      nextCursor: ordenados.length > limite && ultimo !== undefined ? encodeCursor(ultimo) : null,
    })
  }

  agregarMensaje(
    conversationId: string,
    senderId: string,
    body: string,
    ahora: Date,
  ): Promise<MensajeVista> {
    const conv = this.conversaciones.find((c) => c.id === conversationId)
    if (conv === undefined) return Promise.reject(new Error('conversación inexistente'))
    const mensaje: MensajeVista = {
      id: randomUUID(),
      conversationId,
      senderId,
      body,
      createdAt: ahora,
    }
    this.mensajesGuardados.push(mensaje)
    if (conv.lastMessageAt === null || conv.lastMessageAt < ahora) conv.lastMessageAt = ahora
    return Promise.resolve({ ...mensaje })
  }

  mensaje(conversationId: string, messageId: string): Promise<MensajeVista | null> {
    const m = this.mensajesGuardados.find(
      (x) => x.id === messageId && x.conversationId === conversationId,
    )
    return Promise.resolve(m === undefined ? null : { ...m })
  }

  marcar(
    conversationId: string,
    userId: string,
    tipo: 'delivered' | 'read',
    upTo: string,
  ): Promise<MarcasDeParticipante | false> {
    const mensaje = this.mensajesGuardados.find(
      (m) => m.id === upTo && m.conversationId === conversationId,
    )
    const participante = this.conversaciones
      .find((c) => c.id === conversationId)
      ?.participantes.find((p) => p.userId === userId)
    if (mensaje === undefined || participante === undefined) return Promise.resolve(false)

    const nueva = { at: mensaje.createdAt, id: mensaje.id }
    if (tipo === 'read') participante.read = avanzar(participante.read, nueva)
    else participante.delivered = avanzar(participante.delivered, nueva)
    return Promise.resolve({ deliveredUpTo: participante.delivered, readUpTo: participante.read })
  }

  participantes(conversationId: string): Promise<string[]> {
    const conv = this.conversaciones.find((c) => c.id === conversationId)
    return Promise.resolve(conv === undefined ? [] : conv.participantes.map((p) => p.userId))
  }

  private rolHoy(eventId: string, userId: string): RolEnEvento | null {
    const m = this.miembros.find((x) => x.eventId === eventId && x.userId === userId)
    if (m?.status === 'ACTIVE') return m.role
    const contratado = this.proveedores.some(
      (p) => p.eventId === eventId && p.userId === userId && p.booked,
    )
    return contratado && this.publicados.has(eventId) ? 'VENDOR' : null
  }

  private vista(conv: ConversacionEnMemoria, userId: string): ConversacionVista | null {
    const yo = conv.participantes.find((p) => p.userId === userId)
    const otro = conv.participantes.find((p) => p.userId !== userId)
    if (yo === undefined || otro === undefined) return null

    const miRolHoy = this.rolHoy(conv.eventId, userId)
    const suRolHoy = this.rolHoy(conv.eventId, otro.userId)
    const fueMiembro = this.miembros.some((m) => m.eventId === conv.eventId && m.userId === userId)
    if (miRolHoy === null && !fueMiembro) return null

    const miembroOtro = this.miembros.find(
      (m) => m.eventId === conv.eventId && m.userId === otro.userId,
    )
    const rol: RolEnEvento = suRolHoy ?? miembroOtro?.role ?? 'VENDOR'
    // Como Prisma: el negocio es de la ficha del usuario (no del evento) y, sin
    // ficha, cuenta el nombre. Sin ninguno de los dos el escenario está mal montado.
    const negocio = this.proveedores.find((p) => p.userId === otro.userId)
    const displayName =
      rol === 'VENDOR' ? (negocio?.businessName ?? miembroOtro?.fullName) : miembroOtro?.fullName
    if (displayName === undefined) {
      throw new Error(`usuario ${otro.userId} sin registrarMiembro/registrarProveedor en el doble`)
    }

    const delChat = this.mensajesGuardados
      .filter((m) => m.conversationId === conv.id)
      .sort(masReciente)
    const noLeidos = delChat.filter(
      (m) =>
        m.senderId !== userId &&
        (yo.read === null ||
          m.createdAt > yo.read.at ||
          (m.createdAt.getTime() === yo.read.at.getTime() && m.id > yo.read.id)),
    ).length
    const ultimo = delChat[0]

    return {
      id: conv.id,
      event: { id: conv.eventId, name: this.eventos.get(conv.eventId) ?? conv.eventId },
      other: { userId: otro.userId, displayName, role: rol },
      lastMessage: ultimo === undefined ? null : { ...ultimo },
      unreadCount: noLeidos,
      readOnly: miRolHoy === null || suRolHoy === null,
      otherMarks: { deliveredUpTo: otro.delivered, readUpTo: otro.read },
    }
  }
}
