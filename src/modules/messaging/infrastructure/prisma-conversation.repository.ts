import { Injectable } from '@nestjs/common'
import { Prisma, type Message as MensajeFila } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe, enTransaccion } from '@/modules/database/transaccion'
import { encodeCursor, type CursorPage, type CursorValue } from '@/shared/domain'

import type {
  Contacto,
  ConversacionVista,
  ConversationRepository,
  MarcasDeParticipante,
  MensajeVista,
} from '../application/conversation.repository'
import { avanzar, claveDePar, type Marca, type RolEnEvento } from '../domain/conversacion'

/** Más recientes primero; (`createdAt`, `id`) es un orden total y estable. */
const ORDEN_ESTABLE = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.MessageOrderByWithRelationInput[]

const INCLUIR = {
  event: { select: { id: true, name: true, status: true } },
  participants: {
    include: {
      user: { select: { fullName: true, vendorProfile: { select: { businessName: true } } } },
    },
  },
} satisfies Prisma.ConversationInclude

type FilaConversacion = Prisma.ConversationGetPayload<{ include: typeof INCLUIR }>

/** Lo que una consulta de membresía / contratación dice de alguien en un evento. */
interface SituacionEnEvento {
  membresia: { role: 'COUPLE' | 'PLANNER'; status: string } | null
  contratado: boolean
}

/**
 * Adaptador de Prisma de `ConversationRepository`.
 *
 * Acceso de mensajería HOY de alguien a un evento: miembro ACTIVE (el evento
 * esté o no publicado) o proveedor BOOKED (`VendorProfile.userId`) de un evento
 * PUBLICADO (`status: 'ACTIVE'`), como `buscarContratacionReservada`. Los
 * literales se repiten en vez de importar el `domain/` de `events` (un módulo
 * no importa el de otro); lo que los sujeta es la paridad con el doble y el
 * test con INVITED, REVOKED y contrataciones canceladas. Un administrador del
 * sistema no cuenta: su rol global no se mira aquí. Alternativa descartada:
 * guardar un "activa" en la conversación, que habría que mantener al revocar.
 */
@Injectable()
export class PrismaConversationRepository implements ConversationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async rolEnEvento(eventId: string, userId: string): Promise<RolEnEvento | null> {
    const membresia = await this.prisma.eventMembership.findFirst({
      where: { eventId, userId, status: 'ACTIVE' },
      select: { role: true },
    })
    if (membresia !== null) return membresia.role
    const contratado = await this.prisma.event.count({
      where: {
        id: eventId,
        status: 'ACTIVE',
        vendors: { some: { status: 'BOOKED', vendorProfile: { userId } } },
      },
    })
    return contratado > 0 ? 'VENDOR' : null
  }

  async contactos(eventId: string, userId: string): Promise<Contacto[]> {
    const miRol = await this.rolEnEvento(eventId, userId)
    if (miRol === null) return []

    const miembros = await this.prisma.eventMembership.findMany({
      where: { eventId, status: 'ACTIVE', userId: { not: userId } },
      select: { role: true, user: { select: { id: true, fullName: true } } },
    })
    const contactos: Contacto[] = miembros.map((m) => ({
      userId: m.user.id,
      displayName: m.user.fullName,
      role: m.role,
    }))
    if (miRol === 'VENDOR') return contactos

    const vendors = await this.prisma.eventVendor.findMany({
      where: {
        eventId,
        status: 'BOOKED',
        event: { status: 'ACTIVE' },
        vendorProfile: { userId: { not: userId } },
      },
      select: { vendorProfile: { select: { userId: true, businessName: true } } },
    })
    for (const v of vendors) {
      if (v.vendorProfile === null) continue
      const { userId: id, businessName } = v.vendorProfile
      if (contactos.some((c) => c.userId === id)) continue // si además es miembro, gana el rol de miembro
      contactos.push({ userId: id, displayName: businessName, role: 'VENDOR' })
    }
    return contactos
  }

  /**
   * `clienteDe`: si se llama dentro de una unidad de trabajo, la conversación
   * se confirma con ella. Dos aperturas simultáneas del mismo par chocan en el
   * UNIQUE de `pairKey` (P2002): la perdedora relee y devuelve la existente.
   * Fuera de una transacción el error no deja nada a medias; dentro de una, el
   * llamador debe abrir fuera de ella (la transacción quedaría abortada).
   */
  async abrir(eventId: string, a: string, b: string): Promise<{ id: string; creada: boolean }> {
    const pairKey = claveDePar(eventId, a, b)
    const cliente = clienteDe(this.prisma)
    const existente = await cliente.conversation.findUnique({
      where: { pairKey },
      select: { id: true },
    })
    if (existente !== null) return { id: existente.id, creada: false }

    try {
      const creada = await cliente.conversation.create({
        data: {
          kind: 'EVENT_DIRECT',
          eventId,
          pairKey,
          participants: { create: [{ userId: a }, { userId: b }] },
        },
        select: { id: true },
      })
      return { id: creada.id, creada: true }
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error
      }
      const ganadora = await this.prisma.conversation.findUniqueOrThrow({
        where: { pairKey },
        select: { id: true },
      })
      return { id: ganadora.id, creada: false }
    }
  }

  async buscar(conversationId: string, userId: string): Promise<ConversacionVista | null> {
    const fila = await this.prisma.conversation.findFirst({
      where: { id: conversationId, kind: 'EVENT_DIRECT', participants: { some: { userId } } },
      include: INCLUIR,
    })
    if (fila === null) return null
    return (await this.vistas(userId, [fila]))[0] ?? null
  }

  async bandeja(userId: string): Promise<{ items: ConversacionVista[]; unreadTotal: number }> {
    const filas = await this.prisma.conversation.findMany({
      where: { kind: 'EVENT_DIRECT', participants: { some: { userId } } },
      include: INCLUIR,
    })
    const items = await this.vistas(userId, filas)
    const orden = new Map(filas.map((f) => [f.id, f]))
    items.sort((x, y) => {
      const fx = orden.get(x.id)
      const fy = orden.get(y.id)
      const tx = fx?.lastMessageAt?.getTime() ?? Number.NEGATIVE_INFINITY
      const ty = fy?.lastMessageAt?.getTime() ?? Number.NEGATIVE_INFINITY
      if (tx !== ty) return ty - tx
      const cx = fx?.createdAt.getTime() ?? 0
      const cy = fy?.createdAt.getTime() ?? 0
      return cy - cx || (x.id < y.id ? 1 : -1)
    })
    return { items, unreadTotal: items.reduce((suma, v) => suma + v.unreadCount, 0) }
  }

  async mensajes(
    conversationId: string,
    { desde, limite }: { desde: CursorValue | null; limite: number },
  ): Promise<CursorPage<MensajeVista>> {
    const filas = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(desde !== null
          ? {
              OR: [
                { createdAt: { lt: desde.createdAt } },
                { createdAt: desde.createdAt, id: { lt: desde.id } },
              ],
            }
          : {}),
      },
      orderBy: ORDEN_ESTABLE,
      take: limite + 1,
    })
    const hayMas = filas.length > limite
    const pagina = hayMas ? filas.slice(0, limite) : filas
    const ultimo = pagina.at(-1)
    return {
      items: pagina.map(aMensaje),
      nextCursor: hayMas && ultimo !== undefined ? encodeCursor(ultimo) : null,
    }
  }

  /**
   * Mensaje y `lastMessageAt` en la misma transacción (`enTransaccion` se une
   * a la unidad de trabajo si la hay): sin ella la bandeja podría ordenar por
   * un mensaje que no existe, o ignorar uno que sí. `lastMessageAt` sólo
   * avanza: un mensaje con `ahora` anterior no lo hace retroceder.
   */
  async agregarMensaje(
    conversationId: string,
    senderId: string,
    body: string,
    ahora: Date,
  ): Promise<MensajeVista> {
    return await enTransaccion(this.prisma, async (tx) => {
      const fila = await tx.message.create({
        data: { conversationId, senderId, body, createdAt: ahora },
      })
      await tx.conversation.updateMany({
        where: {
          id: conversationId,
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: ahora } }],
        },
        data: { lastMessageAt: ahora },
      })
      return aMensaje(fila)
    })
  }

  /**
   * Bloquea la fila del participante (`FOR UPDATE`) antes de leer su marca:
   * dos marcados simultáneos serializan y el segundo ve el resultado del
   * primero, así que "nunca retrocede" vale también con concurrencia.
   */
  async marcar(
    conversationId: string,
    userId: string,
    tipo: 'delivered' | 'read',
    upTo: string,
  ): Promise<MarcasDeParticipante | false> {
    const mensaje = await this.prisma.message.findFirst({
      where: { id: upTo, conversationId },
      select: { id: true, createdAt: true },
    })
    if (mensaje === null) return false

    return await enTransaccion(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "conversation_participants"
        WHERE "conversationId" = ${conversationId}::uuid AND "userId" = ${userId}::uuid
        FOR UPDATE`
      const fila = await tx.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      })
      if (fila === null) return false

      const actual =
        tipo === 'read'
          ? marcaDe(fila.readUpToAt, fila.readUpToId)
          : marcaDe(fila.deliveredUpToAt, fila.deliveredUpToId)
      const nueva = avanzar(actual, { at: mensaje.createdAt, id: mensaje.id })
      const actualizada = await tx.conversationParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data:
          tipo === 'read'
            ? { readUpToAt: nueva.at, readUpToId: nueva.id }
            : { deliveredUpToAt: nueva.at, deliveredUpToId: nueva.id },
      })
      return {
        deliveredUpTo: marcaDe(actualizada.deliveredUpToAt, actualizada.deliveredUpToId),
        readUpTo: marcaDe(actualizada.readUpToAt, actualizada.readUpToId),
      }
    })
  }

  async participantes(conversationId: string): Promise<string[]> {
    const filas = await this.prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    })
    return filas.map((f) => f.userId)
  }

  /**
   * Convierte conversaciones en vistas de `userId` y descarta las que no
   * puede ver. Se resuelve por lotes (membresías, contrataciones, recuentos)
   * y no una consulta por conversación.
   */
  private async vistas(userId: string, filas: FilaConversacion[]): Promise<ConversacionVista[]> {
    if (filas.length === 0) return []
    const eventIds = [...new Set(filas.flatMap((f) => (f.eventId === null ? [] : [f.eventId])))]
    const usuarios = [...new Set(filas.flatMap((f) => f.participants.map((p) => p.userId)))]

    const [membresias, contrataciones, noLeidos, ultimos] = await Promise.all([
      this.prisma.eventMembership.findMany({
        where: { eventId: { in: eventIds }, userId: { in: usuarios } },
        select: { eventId: true, userId: true, role: true, status: true },
      }),
      this.prisma.eventVendor.findMany({
        where: {
          eventId: { in: eventIds },
          status: 'BOOKED',
          vendorProfile: { userId: { in: usuarios } },
        },
        select: { eventId: true, vendorProfile: { select: { userId: true } } },
      }),
      this.contarNoLeidos(
        userId,
        filas.map((f) => f.id),
      ),
      Promise.all(
        filas.map((f) =>
          this.prisma.message.findFirst({
            where: { conversationId: f.id },
            orderBy: ORDEN_ESTABLE,
          }),
        ),
      ),
    ])

    const situacion = (eventId: string, id: string): SituacionEnEvento => {
      const m = membresias.find((x) => x.eventId === eventId && x.userId === id)
      return {
        membresia: m === undefined ? null : { role: m.role, status: m.status },
        contratado: contrataciones.some(
          (c) => c.eventId === eventId && c.vendorProfile?.userId === id,
        ),
      }
    }

    const vistas: ConversacionVista[] = []
    filas.forEach((fila, i) => {
      if (fila.event === null || fila.eventId === null) return
      const yo = fila.participants.find((p) => p.userId === userId)
      const otro = fila.participants.find((p) => p.userId !== userId)
      if (yo === undefined || otro === undefined) return

      const publicado = fila.event.status === 'ACTIVE'
      const mia = situacion(fila.eventId, userId)
      const suya = situacion(fila.eventId, otro.userId)
      const rolHoy = (s: SituacionEnEvento): RolEnEvento | null =>
        s.membresia?.status === 'ACTIVE'
          ? s.membresia.role
          : s.contratado && publicado
            ? 'VENDOR'
            : null

      const miRolHoy = rolHoy(mia)
      const suRolHoy = rolHoy(suya)
      // Quien perdió el acceso sigue viéndola sólo si es (o fue) miembro.
      if (miRolHoy === null && mia.membresia === null) return

      const rolOtro: RolEnEvento = suRolHoy ?? suya.membresia?.role ?? 'VENDOR'
      const ultimo = ultimos[i]
      vistas.push({
        id: fila.id,
        event: { id: fila.event.id, name: fila.event.name },
        other: {
          userId: otro.userId,
          displayName:
            rolOtro === 'VENDOR'
              ? (otro.user.vendorProfile?.businessName ?? otro.user.fullName)
              : otro.user.fullName,
          role: rolOtro,
        },
        lastMessage: ultimo === null || ultimo === undefined ? null : aMensaje(ultimo),
        unreadCount: noLeidos.get(fila.id) ?? 0,
        readOnly: miRolHoy === null || suRolHoy === null,
        otherMarks: {
          deliveredUpTo: marcaDe(otro.deliveredUpToAt, otro.deliveredUpToId),
          readUpTo: marcaDe(otro.readUpToAt, otro.readUpToId),
        },
      })
    })
    return vistas
  }

  /**
   * Mensajes del otro posteriores a MI marca de lectura, por conversación, en
   * una sola consulta. Comparación de fila `(createdAt, id)`: el mismo orden
   * total que usa el dominio. SQL con plantilla etiquetada (parametrizada).
   */
  private async contarNoLeidos(userId: string, ids: string[]): Promise<Map<string, number>> {
    const filas = await this.prisma.$queryRaw<Array<{ conversationId: string; total: bigint }>>`
      SELECT m."conversationId", count(*) AS total
      FROM "messages" m
      JOIN "conversation_participants" p
        ON p."conversationId" = m."conversationId" AND p."userId" = ${userId}::uuid
      WHERE m."conversationId" = ANY(${ids}::uuid[])
        AND m."senderId" <> p."userId"
        AND (p."readUpToAt" IS NULL OR (m."createdAt", m."id") > (p."readUpToAt", p."readUpToId"))
      GROUP BY m."conversationId"`
    return new Map(filas.map((f) => [f.conversationId, Number(f.total)]))
  }
}

function marcaDe(at: Date | null, id: string | null): Marca | null {
  return at === null || id === null ? null : { at, id }
}

function aMensaje(fila: MensajeFila): MensajeVista {
  return {
    id: fila.id,
    conversationId: fila.conversationId,
    senderId: fila.senderId,
    body: fila.body,
    createdAt: fila.createdAt,
  }
}
