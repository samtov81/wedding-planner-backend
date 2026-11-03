import { Injectable } from '@nestjs/common'
import { Prisma, type Message as MensajeFila } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe, enTransaccion } from '@/modules/database/transaccion'
import { encodeCursor, type CursorPage, type CursorValue } from '@/shared/domain'

import type {
  Contacto,
  ConversacionDePerfilVista,
  ConversacionVista,
  ConversationRepository,
  FichaParaContacto,
  MarcaDeMiembro,
  MarcasDeParticipante,
  MensajeVista,
  SalaVista,
} from '../application/conversation.repository'
import { avanzar, claveDePar, type Marca, type RolEnEvento } from '../domain/conversacion'
import { ParNoPermitidoError } from '../domain/messaging-errors'
import {
  claveDePerfil,
  evaluarSolicitud,
  reintentoEn,
  veConversacionDePerfil,
  type ParDePerfil,
} from '../domain/perfil'
import { claveDeSala } from '../domain/sala'

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

const INCLUIR_SALA = {
  event: { select: { id: true, name: true } },
} satisfies Prisma.ConversationInclude

type FilaSala = Prisma.ConversationGetPayload<{ include: typeof INCLUIR_SALA }>

const INCLUIR_PERFIL = {
  vendorProfile: { select: { id: true, userId: true, businessName: true } },
  participants: { include: { user: { select: { fullName: true } } } },
} satisfies Prisma.ConversationInclude

type FilaPerfil = Prisma.ConversationGetPayload<{ include: typeof INCLUIR_PERFIL }>

/** La fila del par tal como la lee `SELECT … FOR UPDATE` (`parBloqueado`). */
interface FilaParBloqueado {
  id: string
  requesterId: string | null
  requestStatus: 'PENDING' | 'ACCEPTED' | 'DECLINED' | null
  declinedAt: Date | null
  vendorUserId: string
}

type Cliente = ReturnType<typeof clienteDe>

/** Lo que una consulta de membresía / contratación dice de alguien en un evento. */
interface SituacionEnEvento {
  membresia: { role: 'COUPLE' | 'PLANNER'; status: string } | null
  contratado: boolean
}

/**
 * Orden de las bandejas (1:1, salas y perfiles): `lastMessageAt` desc (sin
 * mensajes al final), luego `createdAt` desc y el id. Se ordena en memoria tras
 * construir las vistas, que descartan las que `userId` no ve.
 */
function ordenarComoBandeja<T extends { id: string }>(
  items: T[],
  filas: Array<{ id: string; lastMessageAt: Date | null; createdAt: Date }>,
): T[] {
  const orden = new Map(filas.map((f) => [f.id, f]))
  return items.sort((x, y) => {
    const fx = orden.get(x.id)
    const fy = orden.get(y.id)
    const tx = fx?.lastMessageAt?.getTime() ?? Number.NEGATIVE_INFINITY
    const ty = fy?.lastMessageAt?.getTime() ?? Number.NEGATIVE_INFINITY
    if (tx !== ty) return ty - tx
    const cx = fx?.createdAt.getTime() ?? 0
    const cy = fy?.createdAt.getTime() ?? 0
    return cy - cx || (x.id < y.id ? 1 : -1)
  })
}

/** Orden de `miembrosDeSala`: nombre y, a igualdad, id. El doble repite el mismo criterio. */
const porNombreYId = (a: Contacto, b: Contacto): number =>
  a.displayName < b.displayName
    ? -1
    : a.displayName > b.displayName
      ? 1
      : a.userId < b.userId
        ? -1
        : a.userId > b.userId
          ? 1
          : 0

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
    const membresia = await clienteDe(this.prisma).eventMembership.findFirst({
      where: { eventId, userId, status: 'ACTIVE' },
      select: { role: true },
    })
    if (membresia !== null) return membresia.role
    const contratado = await clienteDe(this.prisma).event.count({
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

    const miembros = await clienteDe(this.prisma).eventMembership.findMany({
      where: { eventId, status: 'ACTIVE', userId: { not: userId } },
      select: { role: true, user: { select: { id: true, fullName: true } } },
    })
    const contactos: Contacto[] = miembros.map((m) => ({
      userId: m.user.id,
      displayName: m.user.fullName,
      role: m.role,
    }))
    if (miRol === 'VENDOR') return contactos

    const vendors = await clienteDe(this.prisma).eventVendor.findMany({
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
   * `INSERT … ON CONFLICT ("pairKey") DO NOTHING`, no `create` + captura de
   * P2002: dentro de una unidad de trabajo un error de Postgres deja la
   * transacción abortada ("current transaction is aborted") y la petición
   * acabaría en 500, que el ruling 1 prohíbe. Con `DO NOTHING` el choque no es
   * un error: si no devuelve fila, otra petición ganó y se lee su conversación
   * (la perdedora espera a que la ganadora confirme). Conversación y
   * participantes van en `enTransaccion` para que nadie vea la primera sin los
   * segundos. Alternativa descartada: SAVEPOINT, que Prisma no expone.
   */
  async abrir(eventId: string, a: string, b: string): Promise<{ id: string; creada: boolean }> {
    if (a === b) throw new ParNoPermitidoError()
    const pairKey = claveDePar(eventId, a, b)
    return await enTransaccion(this.prisma, async (tx) => {
      const filas = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "conversations" ("id", "kind", "eventId", "pairKey")
        VALUES (gen_random_uuid(), 'EVENT_DIRECT'::"ConversationKind", ${eventId}::uuid, ${pairKey})
        ON CONFLICT ("pairKey") DO NOTHING
        RETURNING "id"`
      const nueva = filas[0]
      if (nueva !== undefined) {
        await tx.conversationParticipant.createMany({
          data: [
            { conversationId: nueva.id, userId: a },
            { conversationId: nueva.id, userId: b },
          ],
        })
        return { id: nueva.id, creada: true }
      }
      const existente = await tx.conversation.findUniqueOrThrow({
        where: { pairKey },
        select: { id: true },
      })
      return { id: existente.id, creada: false }
    })
  }

  async buscar(conversationId: string, userId: string): Promise<ConversacionVista | null> {
    const fila = await clienteDe(this.prisma).conversation.findFirst({
      where: { id: conversationId, kind: 'EVENT_DIRECT', participants: { some: { userId } } },
      include: INCLUIR,
    })
    if (fila === null) return null
    return (await this.vistas(userId, [fila]))[0] ?? null
  }

  async bandeja(userId: string): Promise<{ items: ConversacionVista[]; unreadTotal: number }> {
    const filas = await clienteDe(this.prisma).conversation.findMany({
      where: { kind: 'EVENT_DIRECT', participants: { some: { userId } } },
      include: INCLUIR,
    })
    const items = await this.vistas(userId, filas)
    ordenarComoBandeja(items, filas)
    return { items, unreadTotal: items.reduce((suma, v) => suma + v.unreadCount, 0) }
  }

  async mensajes(
    conversationId: string,
    {
      desde,
      limite,
      hasta,
    }: { desde: CursorValue | null; limite: number; hasta?: Marca | null | undefined },
  ): Promise<CursorPage<MensajeVista>> {
    if (hasta === null) return { items: [], nextCursor: null }
    const filas = await clienteDe(this.prisma).message.findMany({
      where: {
        conversationId,
        AND: [
          desde !== null
            ? {
                OR: [
                  { createdAt: { lt: desde.createdAt } },
                  { createdAt: desde.createdAt, id: { lt: desde.id } },
                ],
              }
            : {},
          // El tope del lector en solo lectura es inclusivo: `hasta` se ve.
          hasta !== undefined
            ? {
                OR: [
                  { createdAt: { lt: hasta.at } },
                  { createdAt: hasta.at, id: { lte: hasta.id } },
                ],
              }
            : {},
        ],
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

  async mensaje(conversationId: string, messageId: string): Promise<MensajeVista | null> {
    const fila = await clienteDe(this.prisma).message.findFirst({
      where: { id: messageId, conversationId },
    })
    return fila === null ? null : aMensaje(fila)
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
    const mensaje = await clienteDe(this.prisma).message.findFirst({
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
    const filas = await clienteDe(this.prisma).conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    })
    return filas.map((f) => f.userId)
  }

  async abrirSala(eventId: string, userId: string): Promise<string | null> {
    if (!(await esMiembroActivo(clienteDe(this.prisma), eventId, userId))) {
      const existente = await clienteDe(this.prisma).conversation.findUnique({
        where: { pairKey: claveDeSala(eventId) },
        select: { id: true },
      })
      return existente?.id ?? null
    }
    return await enTransaccion(this.prisma, async (tx) => {
      const id = await asegurarSala(tx, eventId)
      await tx.conversationParticipant.createMany({
        data: [{ conversationId: id, userId }],
        skipDuplicates: true,
      })
      return id
    })
  }

  async buscarSala(conversationId: string, userId: string): Promise<SalaVista | null> {
    const fila = await clienteDe(this.prisma).conversation.findFirst({
      where: { id: conversationId, kind: 'EVENT_ROOM' },
      include: INCLUIR_SALA,
    })
    if (fila === null) return null
    return (await this.vistasDeSala(userId, [fila]))[0] ?? null
  }

  /**
   * Asegura sala y fila de participante en cada evento donde `userId` es
   * ACTIVE (una escritura idempotente en un GET, a cambio de que la sala
   * "exista desde el principio" sin que `events` llame a `messaging`) y luego
   * lista las suyas: esas más las de solo lectura donde ya participó.
   */
  async salas(userId: string): Promise<{ items: SalaVista[]; unreadTotal: number }> {
    const activos = await clienteDe(this.prisma).eventMembership.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { eventId: true },
    })
    if (activos.length > 0) {
      await enTransaccion(this.prisma, async (tx) => {
        const ids: string[] = []
        for (const { eventId } of activos) ids.push(await asegurarSala(tx, eventId))
        await tx.conversationParticipant.createMany({
          data: ids.map((conversationId) => ({ conversationId, userId })),
          skipDuplicates: true,
        })
      })
    }
    const filas = await clienteDe(this.prisma).conversation.findMany({
      where: { kind: 'EVENT_ROOM', participants: { some: { userId } } },
      include: INCLUIR_SALA,
    })
    const items = await this.vistasDeSala(userId, filas)
    ordenarComoBandeja(items, filas)
    return { items, unreadTotal: items.reduce((suma, v) => suma + v.unreadCount, 0) }
  }

  /**
   * Los destinatarios se leen DENTRO de la transacción que guarda el mensaje:
   * son los ACTIVE de ese instante. No se bloquea la membresía: una revocación
   * simultánea cae antes o después del mensaje, y ambas son una historia válida.
   * Orden por `userId` para que el resultado sea estable (y comparable con el doble).
   */
  async agregarMensajeDeSala(
    conversationId: string,
    senderId: string,
    body: string,
    ahora: Date,
  ): Promise<{ mensaje: MensajeVista; destinatarios: string[] }> {
    return await enTransaccion(this.prisma, async (tx) => {
      const sala = await tx.conversation.findFirstOrThrow({
        where: { id: conversationId, kind: 'EVENT_ROOM' },
        select: { eventId: true },
      })
      const miembros = await tx.eventMembership.findMany({
        where: { eventId: sala.eventId ?? '', status: 'ACTIVE', userId: { not: senderId } },
        select: { userId: true },
        orderBy: { userId: 'asc' },
      })
      const destinatarios = miembros.map((m) => m.userId)
      const fila = await tx.message.create({
        data: { conversationId, senderId, body, createdAt: ahora },
      })
      if (destinatarios.length > 0) {
        await tx.messageRecipient.createMany({
          data: destinatarios.map((userId) => ({ messageId: fila.id, userId })),
        })
      }
      await tx.conversationParticipant.createMany({
        data: [senderId, ...destinatarios].map((userId) => ({ conversationId, userId })),
        skipDuplicates: true,
      })
      await tx.conversation.updateMany({
        where: {
          id: conversationId,
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: ahora } }],
        },
        data: { lastMessageAt: ahora },
      })
      return { mensaje: aMensaje(fila), destinatarios }
    })
  }

  async marcasDeSala(conversationId: string): Promise<MarcaDeMiembro[]> {
    const cliente = clienteDe(this.prisma)
    const sala = await cliente.conversation.findUnique({
      where: { id: conversationId },
      select: { eventId: true },
    })
    if (sala?.eventId == null) return []
    const participantes = await cliente.conversationParticipant.findMany({
      where: { conversationId },
      include: { user: { select: { fullName: true } } },
      orderBy: { userId: 'asc' },
    })
    const membresias = await cliente.eventMembership.findMany({
      where: { eventId: sala.eventId, userId: { in: participantes.map((p) => p.userId) } },
      select: { userId: true, role: true },
    })
    return participantes.flatMap((p) => {
      const m = membresias.find((x) => x.userId === p.userId)
      if (m === undefined) return []
      return [
        {
          userId: p.userId,
          displayName: p.user.fullName,
          role: m.role,
          deliveredUpTo: marcaDe(p.deliveredUpToAt, p.deliveredUpToId),
          readUpTo: marcaDe(p.readUpToAt, p.readUpToId),
        },
      ]
    })
  }

  async miembrosDeSala(conversationId: string): Promise<Contacto[]> {
    const cliente = clienteDe(this.prisma)
    const sala = await cliente.conversation.findUnique({
      where: { id: conversationId },
      select: { eventId: true, kind: true },
    })
    if (sala?.eventId == null || sala.kind !== 'EVENT_ROOM') return []
    const filas = await cliente.eventMembership.findMany({
      where: { eventId: sala.eventId, status: 'ACTIVE' },
      select: { role: true, user: { select: { id: true, fullName: true } } },
    })
    // Se ordena aquí y no en SQL: el doble ordena con `<` y la intercalación de
    // Postgres podría discrepar en mayúsculas o acentos. Un solo criterio.
    return filas
      .map((m) => ({ userId: m.user.id, displayName: m.user.fullName, role: m.role }))
      .sort(porNombreYId)
  }

  async tipoDe(conversationId: string): Promise<'EVENT_DIRECT' | 'EVENT_ROOM' | 'PROFILE' | null> {
    const fila = await clienteDe(this.prisma).conversation.findUnique({
      where: { id: conversationId },
      select: { kind: true },
    })
    return fila?.kind ?? null
  }

  async destinatariosDe(messageIds: readonly string[]): Promise<Map<string, string[]>> {
    const filas = await clienteDe(this.prisma).messageRecipient.findMany({
      where: { messageId: { in: [...messageIds] } },
      orderBy: [{ messageId: 'asc' }, { userId: 'asc' }],
    })
    const r = new Map<string, string[]>()
    for (const f of filas) r.set(f.messageId, [...(r.get(f.messageId) ?? []), f.userId])
    return r
  }

  // ── Contacto desde la ficha (parte 3) ─────────────────────────────────────

  async fichaParaContacto(vendorProfileId: string): Promise<FichaParaContacto | null> {
    const fila = await clienteDe(this.prisma).vendorProfile.findUnique({
      where: { id: vendorProfileId },
      select: { id: true, userId: true, businessName: true, status: true },
    })
    if (fila === null) return null
    const { status, ...ficha } = fila
    return { ...ficha, publicada: status === 'PUBLISHED' }
  }

  async parDePerfil(a: string, b: string): Promise<ParDePerfil | null> {
    const fila = await clienteDe(this.prisma).conversation.findFirst({
      where: { pairKey: claveDePerfil(a, b), kind: 'PROFILE' },
      select: {
        id: true,
        requesterId: true,
        requestStatus: true,
        declinedAt: true,
        vendorProfile: { select: { userId: true } },
      },
    })
    if (fila?.vendorProfile == null) return null
    return aPar({ ...fila, vendorUserId: fila.vendorProfile.userId })
  }

  /**
   * Relación = algún evento donde los dos tienen acceso de mensajería HOY (la
   * regla de `rolEnEvento`: miembro ACTIVE, o proveedor BOOKED de un evento
   * publicado; si es las dos cosas, gana miembro) y no son los dos proveedores.
   * Dos consultas para el par, no una por evento; el cruce se hace en memoria.
   * Alternativa descartada: una sola consulta SQL con el cruce, que duplicaría
   * en SQL la regla que aquí ya está escrita una vez con Prisma.
   */
  async tienenRelacion(a: string, b: string): Promise<boolean> {
    const cliente = clienteDe(this.prisma)
    const [membresias, contrataciones] = await Promise.all([
      cliente.eventMembership.findMany({
        where: { userId: { in: [a, b] }, status: 'ACTIVE' },
        select: { eventId: true, userId: true },
      }),
      cliente.eventVendor.findMany({
        where: {
          status: 'BOOKED',
          event: { status: 'ACTIVE' },
          vendorProfile: { userId: { in: [a, b] } },
        },
        select: { eventId: true, vendorProfile: { select: { userId: true } } },
      }),
    ])
    const rol = (eventId: string, userId: string): 'MIEMBRO' | 'VENDOR' | null =>
      membresias.some((m) => m.eventId === eventId && m.userId === userId)
        ? 'MIEMBRO'
        : contrataciones.some((c) => c.eventId === eventId && c.vendorProfile?.userId === userId)
          ? 'VENDOR'
          : null
    const eventos = new Set([...membresias, ...contrataciones].map((x) => x.eventId))
    for (const eventId of eventos) {
      const rolA = rol(eventId, a)
      const rolB = rol(eventId, b)
      if (rolA !== null && rolB !== null && !(rolA === 'VENDOR' && rolB === 'VENDOR')) return true
    }
    return false
  }

  /**
   * Todo en una transacción (`enTransaccion`, que se une a la unidad de
   * trabajo si la hay): bloquear la fila del par (`FOR UPDATE`), evaluar con
   * `evaluarSolicitud`, crear o reintentar y añadir el mensaje con su
   * `lastMessageAt`. Crear es `INSERT … ON CONFLICT ("pairKey") DO NOTHING`
   * como `abrir`: si no inserta, otra petición del mismo par (A→B y B→A a la
   * vez) ganó; se espera a que confirme, se bloquea su fila y se vuelve a
   * evaluar con ella, que da el 409 que toque en vez de un 500 por el UNIQUE.
   * Los errores de dominio salen antes de cualquier escritura de esta petición
   * y deshacen la transacción. Alternativa descartada: bloqueo consultivo por
   * clave (`pg_advisory_xact_lock`), que serializa igual pero deja la carrera
   * fuera de lo que el UNIQUE ya garantiza.
   */
  async solicitar(e: {
    solicitante: string
    ficha: FichaParaContacto
    cuerpo: string
    relacionados: boolean
    ahora: Date
  }): Promise<{ conversationId: string; mensaje: MensajeVista }> {
    const pairKey = claveDePerfil(e.solicitante, e.ficha.userId)
    const evaluar = (fila: FilaParBloqueado | null): ReturnType<typeof evaluarSolicitud> =>
      evaluarSolicitud({
        solicitante: e.solicitante,
        duenoDeFicha: e.ficha.userId,
        par: fila === null ? null : aPar(fila),
        relacionados: e.relacionados,
        ahora: e.ahora,
      })

    return await enTransaccion(this.prisma, async (tx) => {
      let fila = await parBloqueado(tx, { pairKey })
      let decision = evaluar(fila)
      let conversationId: string | null = null
      if (decision.accion === 'crear') {
        const filas = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "conversations"
            ("id", "kind", "pairKey", "requesterId", "vendorProfileId", "requestStatus")
          VALUES (gen_random_uuid(), 'PROFILE'::"ConversationKind", ${pairKey},
            ${e.solicitante}::uuid, ${e.ficha.id}::uuid,
            ${decision.estado}::"ContactRequestStatus")
          ON CONFLICT ("pairKey") DO NOTHING
          RETURNING "id"`
        const nueva = filas[0]
        if (nueva !== undefined) {
          await tx.conversationParticipant.createMany({
            data: [
              { conversationId: nueva.id, userId: e.solicitante },
              { conversationId: nueva.id, userId: e.ficha.userId },
            ],
          })
          conversationId = nueva.id
        } else {
          fila = await parBloqueado(tx, { pairKey })
          decision = evaluar(fila)
        }
      }
      if (conversationId === null) {
        if (fila === null) throw new Error(`par ${pairKey} sin fila tras el choque`)
        // Reintento: `requesterId` y `vendorProfileId` no cambian nunca (spec §3.6).
        await tx.conversation.update({
          where: { id: fila.id },
          data: { requestStatus: decision.estado, declinedAt: null },
        })
        conversationId = fila.id
      }
      const mensaje = await this.agregarMensaje(conversationId, e.solicitante, e.cuerpo, e.ahora)
      return { conversationId, mensaje }
    })
  }

  /** `FOR UPDATE` de la fila: un aceptar y un rechazar simultáneos serializan. */
  async responder(
    conversationId: string,
    userId: string,
    decision: 'ACCEPTED' | 'DECLINED',
    ahora: Date,
  ): Promise<'ok' | 'no-encontrada' | 'no-pendiente'> {
    return await enTransaccion(this.prisma, async (tx) => {
      const fila = await parBloqueado(tx, { conversationId })
      if (fila === null || fila.vendorUserId !== userId) return 'no-encontrada'
      if (fila.requestStatus !== 'PENDING') return 'no-pendiente'
      await tx.conversation.update({
        where: { id: fila.id },
        data: { requestStatus: decision, declinedAt: decision === 'DECLINED' ? ahora : null },
      })
      return 'ok'
    })
  }

  async buscarPerfil(
    conversationId: string,
    userId: string,
  ): Promise<ConversacionDePerfilVista | null> {
    const fila = await clienteDe(this.prisma).conversation.findFirst({
      where: { id: conversationId, kind: 'PROFILE' },
      include: INCLUIR_PERFIL,
    })
    if (fila === null) return null
    return (await this.vistasDePerfil(userId, [fila]))[0] ?? null
  }

  async perfiles(userId: string): Promise<{
    items: ConversacionDePerfilVista[]
    requestsPending: number
    unreadTotal: number
  }> {
    const filas = await clienteDe(this.prisma).conversation.findMany({
      where: { kind: 'PROFILE', participants: { some: { userId } } },
      include: INCLUIR_PERFIL,
    })
    const items = ordenarComoBandeja(await this.vistasDePerfil(userId, filas), filas)
    return {
      items,
      requestsPending: items.filter((v) => v.direction === 'RECEIVED' && v.status === 'PENDING')
        .length,
      unreadTotal: items
        .filter((v) => v.status === 'ACCEPTED')
        .reduce((suma, v) => suma + v.unreadCount, 0),
    }
  }

  /**
   * Vistas `PROFILE` de `userId` por lotes (no leídos y último mensaje: dos
   * consultas en total, las mismas que la 1:1). Descarta las que no ve según
   * `veConversacionDePerfil`. Nombres (spec §3.7): el proveedor con el
   * `businessName` de la ficha de la conversación; el solicitante con su
   * `fullName`, aunque tenga ficha propia.
   */
  private async vistasDePerfil(
    userId: string,
    filas: FilaPerfil[],
  ): Promise<ConversacionDePerfilVista[]> {
    if (filas.length === 0) return []
    const ids = filas.map((f) => f.id)
    const [noLeidos, ultimos] = await Promise.all([
      this.contarNoLeidos(userId, ids),
      this.ultimosMensajes(ids),
    ])
    return filas.flatMap((fila): ConversacionDePerfilVista[] => {
      const ficha = fila.vendorProfile
      if (ficha === null) return []
      const par = aPar({ ...fila, vendorUserId: ficha.userId })
      if (!veConversacionDePerfil(par, userId)) return []
      const otro = fila.participants.find((p) => p.userId !== userId)
      if (otro === undefined) return []

      const soySolicitante = userId === par.requesterId
      const ultimo = ultimos.get(fila.id)
      return [
        {
          id: fila.id,
          status: par.status,
          direction: soySolicitante ? 'SENT' : 'RECEIVED',
          other: soySolicitante
            ? { userId: ficha.userId, displayName: ficha.businessName, role: 'VENDOR' }
            : { userId: otro.userId, displayName: otro.user.fullName, role: 'CONTACT' },
          vendor: { id: ficha.id, businessName: ficha.businessName },
          lastMessage: ultimo === undefined ? null : aMensaje(ultimo),
          unreadCount: noLeidos.get(fila.id) ?? 0,
          readOnly: par.status !== 'ACCEPTED',
          retryAt:
            soySolicitante && par.status === 'DECLINED' && par.declinedAt !== null
              ? reintentoEn(par.declinedAt)
              : null,
          otherMarks: {
            deliveredUpTo: marcaDe(otro.deliveredUpToAt, otro.deliveredUpToId),
            readUpTo: marcaDe(otro.readUpToAt, otro.readUpToId),
          },
        },
      ]
    })
  }

  /**
   * Vistas de sala de `userId` por lotes. Ve la sala quien es ACTIVE hoy (sin
   * tope); si no, quien es participante y tiene alguna membresía (REVOKED o
   * INVITED tras salir), en solo lectura y hasta su último mensaje como
   * remitente o destinatario. Un proveedor nunca es participante: no la ve.
   */
  private async vistasDeSala(userId: string, filas: FilaSala[]): Promise<SalaVista[]> {
    if (filas.length === 0) return []
    const ids = filas.map((f) => f.id)
    const eventIds = [...new Set(filas.flatMap((f) => (f.eventId === null ? [] : [f.eventId])))]
    const cliente = clienteDe(this.prisma)
    const [membresias, participaciones, activos, noLeidos, ultimos, topes] = await Promise.all([
      cliente.eventMembership.findMany({
        where: { userId, eventId: { in: eventIds } },
        select: { eventId: true, status: true },
      }),
      cliente.conversationParticipant.findMany({
        where: { userId, conversationId: { in: ids } },
        select: { conversationId: true },
      }),
      cliente.eventMembership.groupBy({
        by: ['eventId'],
        where: { eventId: { in: eventIds }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      this.contarNoLeidosDeSala(userId, ids),
      this.ultimosMensajes(ids),
      this.topesDeLectura(userId, ids),
    ])

    const vistas: SalaVista[] = []
    for (const fila of filas) {
      if (fila.event === null || fila.eventId === null) continue
      const membresia = membresias.find((m) => m.eventId === fila.eventId)
      const activo = membresia?.status === 'ACTIVE'
      const participa = participaciones.some((p) => p.conversationId === fila.id)
      if (!activo && (membresia === undefined || !participa)) continue

      const tope = activo ? undefined : topes.get(fila.id)
      const ultimo = activo ? ultimos.get(fila.id) : tope
      vistas.push({
        id: fila.id,
        event: { id: fila.event.id, name: fila.event.name },
        memberCount: activos.find((a) => a.eventId === fila.eventId)?._count._all ?? 0,
        lastMessage: ultimo === undefined ? null : aMensaje(ultimo),
        unreadCount: noLeidos.get(fila.id) ?? 0,
        readOnly: !activo,
        visibleHasta: tope === undefined ? null : { at: tope.createdAt, id: tope.id },
      })
    }
    return vistas
  }

  /**
   * Último mensaje de cada sala en el que `userId` fue remitente o
   * destinatario: el tope de lo que ve quien salió. `DISTINCT ON` basta: sólo
   * se pide para salas en solo lectura, que son pocas.
   */
  private async topesDeLectura(userId: string, ids: string[]): Promise<Map<string, MensajeFila>> {
    const filas = await clienteDe(this.prisma).$queryRaw<MensajeFila[]>`
      SELECT DISTINCT ON (m."conversationId")
        m."id", m."conversationId", m."senderId", m."body", m."createdAt"
      FROM "messages" m
      WHERE m."conversationId" = ANY(${ids}::uuid[])
        AND (
          m."senderId" = ${userId}::uuid
          OR EXISTS (
            SELECT 1 FROM "message_recipients" r
            WHERE r."messageId" = m."id" AND r."userId" = ${userId}::uuid
          )
        )
      ORDER BY m."conversationId", m."createdAt" DESC, m."id" DESC`
    return new Map(filas.map((f) => [f.conversationId, f]))
  }

  /**
   * No leídos de sala: mensajes en los que soy DESTINATARIO posteriores a mi
   * marca de lectura. Entra por `message_recipients (userId, messageId)`, así
   * que quien entró tarde no cuenta el historial anterior. Sin fila de
   * participante (un ACTIVE que aún no abrió la sala) cuenta todo lo recibido.
   */
  private async contarNoLeidosDeSala(userId: string, ids: string[]): Promise<Map<string, number>> {
    const filas = await clienteDe(this.prisma).$queryRaw<
      Array<{ conversationId: string; total: bigint }>
    >`
      SELECT m."conversationId", count(*) AS total
      FROM "message_recipients" r
      JOIN "messages" m ON m."id" = r."messageId"
      LEFT JOIN "conversation_participants" p
        ON p."conversationId" = m."conversationId" AND p."userId" = r."userId"
      WHERE r."userId" = ${userId}::uuid
        AND m."conversationId" = ANY(${ids}::uuid[])
        AND (m."createdAt", m."id") > (
          COALESCE(p."readUpToAt", '-infinity'::timestamp),
          COALESCE(p."readUpToId", '00000000-0000-0000-0000-000000000000'::uuid)
        )
      GROUP BY m."conversationId"`
    return new Map(filas.map((f) => [f.conversationId, Number(f.total)]))
  }

  /**
   * Convierte conversaciones en vistas de `userId` y descarta las que no
   * puede ver. Se resuelve por lotes (membresías, contrataciones, recuentos y
   * último mensaje: cuatro consultas en total) y no una por conversación.
   */
  private async vistas(userId: string, filas: FilaConversacion[]): Promise<ConversacionVista[]> {
    if (filas.length === 0) return []
    const eventIds = [...new Set(filas.flatMap((f) => (f.eventId === null ? [] : [f.eventId])))]
    const usuarios = [...new Set(filas.flatMap((f) => f.participants.map((p) => p.userId)))]

    const cliente = clienteDe(this.prisma)
    const [membresias, contrataciones, noLeidos, ultimos] = await Promise.all([
      cliente.eventMembership.findMany({
        where: { eventId: { in: eventIds }, userId: { in: usuarios } },
        select: { eventId: true, userId: true, role: true, status: true },
      }),
      cliente.eventVendor.findMany({
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
      this.ultimosMensajes(filas.map((f) => f.id)),
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
    filas.forEach((fila) => {
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
      // "Fue miembro" = tiene CUALQUIER fila de membresía (no se guarda el historial):
      // un proveedor que además está INVITED (nunca ACTIVE) conserva la vista de
      // solo lectura tras cancelarse su contratación. Caso límite aceptado (ruling 3).
      if (miRolHoy === null && mia.membresia === null) return

      const rolOtro: RolEnEvento = suRolHoy ?? suya.membresia?.role ?? 'VENDOR'
      const ultimo = ultimos.get(fila.id)
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
        lastMessage: ultimo === undefined ? null : aMensaje(ultimo),
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
   * El último mensaje de cada conversación en UNA consulta, no un `findFirst`
   * por conversación. `unnest` + `CROSS JOIN LATERAL ... LIMIT 1` hace, por
   * conversación, un descenso por el índice `(conversationId, createdAt, id)`
   * (orden total del dominio) y se detiene en la primera fila. Alternativa
   * descartada: `DISTINCT ON`, que ordena TODOS los mensajes de las
   * conversaciones pedidas para quedarse con uno de cada una.
   */
  private async ultimosMensajes(ids: string[]): Promise<Map<string, MensajeFila>> {
    const filas = await clienteDe(this.prisma).$queryRaw<MensajeFila[]>`
      SELECT l."id", l."conversationId", l."senderId", l."body", l."createdAt"
      FROM unnest(${ids}::uuid[]) AS c(id)
      CROSS JOIN LATERAL (
        SELECT m."id", m."conversationId", m."senderId", m."body", m."createdAt"
        FROM "messages" m
        WHERE m."conversationId" = c.id
        ORDER BY m."createdAt" DESC, m."id" DESC
        LIMIT 1
      ) AS l`
    return new Map(filas.map((f) => [f.conversationId, f]))
  }

  /**
   * Mensajes del otro posteriores a MI marca de lectura, por conversación, en
   * una sola consulta. Comparación de fila `(createdAt, id)`: el mismo orden
   * total que usa el dominio. Sin marca, el límite es `-infinity` / uuid nulo
   * (todo mensaje es posterior), en vez de un `IS NULL OR ...` que impedía
   * usar el índice `(conversationId, createdAt, id)` como rango. Los tipos de
   * las constantes son los de las columnas (`timestamp(3)`, `uuid`). SQL con
   * plantilla etiquetada (parametrizada).
   */
  private async contarNoLeidos(userId: string, ids: string[]): Promise<Map<string, number>> {
    const filas = await clienteDe(this.prisma).$queryRaw<
      Array<{ conversationId: string; total: bigint }>
    >`
      SELECT m."conversationId", count(*) AS total
      FROM "messages" m
      JOIN "conversation_participants" p
        ON p."conversationId" = m."conversationId" AND p."userId" = ${userId}::uuid
      WHERE m."conversationId" = ANY(${ids}::uuid[])
        AND m."senderId" <> p."userId"
        AND (m."createdAt", m."id") > (
          COALESCE(p."readUpToAt", '-infinity'::timestamp),
          COALESCE(p."readUpToId", '00000000-0000-0000-0000-000000000000'::uuid)
        )
      GROUP BY m."conversationId"`
    return new Map(filas.map((f) => [f.conversationId, Number(f.total)]))
  }
}

async function esMiembroActivo(
  cliente: Cliente,
  eventId: string,
  userId: string,
): Promise<boolean> {
  const n = await cliente.eventMembership.count({ where: { eventId, userId, status: 'ACTIVE' } })
  return n > 0
}

/**
 * Crea la sala del evento o devuelve la que hay, a prueba de choques como
 * `abrir`: `ON CONFLICT ("pairKey") DO NOTHING` y, si no devuelve fila, otra
 * petición ganó y se relee (tras esperar a que confirme). Va dentro de la
 * transacción del llamante.
 */
async function asegurarSala(tx: Prisma.TransactionClient, eventId: string): Promise<string> {
  const pairKey = claveDeSala(eventId)
  const filas = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "conversations" ("id", "kind", "eventId", "pairKey")
    VALUES (gen_random_uuid(), 'EVENT_ROOM'::"ConversationKind", ${eventId}::uuid, ${pairKey})
    ON CONFLICT ("pairKey") DO NOTHING
    RETURNING "id"`
  const nueva = filas[0]
  if (nueva !== undefined) return nueva.id
  const existente = await tx.conversation.findUniqueOrThrow({
    where: { pairKey },
    select: { id: true },
  })
  return existente.id
}

/**
 * Lee y BLOQUEA (`FOR UPDATE OF c`, sólo la conversación, no la ficha) la fila
 * `PROFILE` del par o de la conversación; null si no hay. Va dentro de la
 * transacción del llamante. SQL con plantilla etiquetada (parametrizada); el
 * enum se lee como texto para no depender de cómo Prisma deserializa enums en
 * consultas crudas.
 */
async function parBloqueado(
  tx: Prisma.TransactionClient,
  por: { pairKey: string } | { conversationId: string },
): Promise<FilaParBloqueado | null> {
  const filtro =
    'pairKey' in por
      ? Prisma.sql`c."pairKey" = ${por.pairKey}`
      : Prisma.sql`c."id" = ${por.conversationId}::uuid`
  const filas = await tx.$queryRaw<FilaParBloqueado[]>`
    SELECT c."id", c."requesterId", c."requestStatus"::text AS "requestStatus",
      c."declinedAt", v."userId" AS "vendorUserId"
    FROM "conversations" c
    JOIN "vendor_profiles" v ON v."id" = c."vendorProfileId"
    WHERE ${filtro} AND c."kind" = 'PROFILE'
    FOR UPDATE OF c`
  return filas[0] ?? null
}

/**
 * Fila `PROFILE` → `ParDePerfil`. `requesterId` y `requestStatus` no son null
 * en una `PROFILE` (CHECK `conversations_perfil_campos`); si lo fueran, la
 * base está rota y se falla en vez de inventar un estado.
 */
function aPar(fila: {
  id: string
  requesterId: string | null
  requestStatus: 'PENDING' | 'ACCEPTED' | 'DECLINED' | null
  declinedAt: Date | null
  vendorUserId: string
}): ParDePerfil {
  if (fila.requesterId === null || fila.requestStatus === null) {
    throw new Error(`conversación ${fila.id} PROFILE sin solicitante o sin estado`)
  }
  return {
    conversationId: fila.id,
    requesterId: fila.requesterId,
    vendorUserId: fila.vendorUserId,
    status: fila.requestStatus,
    declinedAt: fila.declinedAt,
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
