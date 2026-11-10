import { Injectable } from '@nestjs/common'
import type { Prisma, ScheduleItem as Fila } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe } from '@/modules/database/transaccion'
import type { Ubicacion } from '@/shared/domain'

import type {
  Asignable,
  AsignacionVista,
  CambiosItem,
  DatosNuevoItem,
  DestinoRecordatorio,
  EstadoProveedor,
  ItemConAsignaciones,
  NotaDeItem,
  PendienteDeProveedor,
  ScheduleItemRepository,
} from '../application/schedule-item.repository'
import { ItemDeCronogramaNoEncontradoError } from '../domain/schedule-errors'
import type { ScheduleItem } from '../domain/schedule-item'

interface ColumnasLugar {
  locationName?: string | null
  locationAddress?: string | null
  locationLat?: number | null
  locationLng?: number | null
  locationMapboxId?: string | null
}

function columnasLugar(location: Ubicacion | null | undefined): ColumnasLugar {
  if (location === undefined) return {}
  if (location === null) {
    return {
      locationName: null,
      locationAddress: null,
      locationLat: null,
      locationLng: null,
      locationMapboxId: null,
    }
  }
  return {
    locationName: location.name,
    locationAddress: location.address,
    locationLat: location.lat,
    locationLng: location.lng,
    locationMapboxId: location.mapboxId,
  }
}

const porTexto = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * "Vigente" (spec 2026-11-10 §3): la contratación está `BOOKED` y tiene ficha.
 * Única copia de la regla en el adaptador; la usan todas las lecturas que
 * cuentan asignaciones. La fila no vigente no se borra: vuelve a contar si se
 * recontrata.
 */
const VIGENTE = {
  eventVendor: { status: 'BOOKED', vendorProfileId: { not: null } },
} satisfies Prisma.ScheduleItemVendorWhereInput

/** Asignaciones vigentes de un usuario: sus contrataciones `BOOKED` (la ficha va implícita). */
const vigentesDe = (userId: string) =>
  ({
    eventVendor: { status: 'BOOKED', vendorProfile: { userId } },
  }) satisfies Prisma.ScheduleItemVendorWhereInput

const INCLUIR_ASIGNACIONES = {
  vendors: {
    where: VIGENTE,
    select: {
      eventVendorId: true,
      confirmedAt: true,
      eventVendor: {
        select: {
          category: { select: { name: true } },
          vendorProfile: { select: { businessName: true } },
        },
      },
    },
  },
} satisfies Prisma.ScheduleItemInclude

const INCLUIR_AUTOR = {
  author: { select: { id: true, fullName: true, avatarKey: true } },
} satisfies Prisma.ScheduleItemNoteInclude

type FilaDeNota = Prisma.ScheduleItemNoteGetPayload<{ include: typeof INCLUIR_AUTOR }>

type FilaConAsignaciones = Prisma.ScheduleItemGetPayload<{ include: typeof INCLUIR_ASIGNACIONES }>

/**
 * Adaptador Prisma del puerto. TODA lectura y escritura va por
 * `clienteDe(this.prisma)` (no-op fuera de una transacción): los casos de uso
 * de asignar, editar con reconfirmación y confirmar corren en una
 * `UnidadDeTrabajo`, y lo que leen tras escribir debe ver lo recién escrito sin
 * confirmar. Alternativa descartada: leer con `this.prisma`, que usa otra
 * conexión y no lo vería (mismo motivo que en `PrismaMoodboardRepository`).
 */
@Injectable()
export class PrismaScheduleItemRepository implements ScheduleItemRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listarPorEvento(eventId: string): Promise<ScheduleItem[]> {
    const filas = await clienteDe(this.prisma).scheduleItem.findMany({
      where: { eventId },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    })
    return filas.map(aDominio)
  }

  async buscarPorId(eventId: string, itemId: string): Promise<ScheduleItem | null> {
    const fila = await clienteDe(this.prisma).scheduleItem.findFirst({
      where: { id: itemId, eventId },
    })
    return fila === null ? null : aDominio(fila)
  }

  async crear(datos: DatosNuevoItem): Promise<ScheduleItem> {
    const fila = await clienteDe(this.prisma).scheduleItem.create({
      data: {
        eventId: datos.eventId,
        title: datos.title,
        description: datos.description,
        startsAt: datos.startsAt,
        endsAt: datos.endsAt,
        status: datos.status,
        ...columnasLugar(datos.location),
      },
    })
    return aDominio(fila)
  }

  async actualizar(eventId: string, itemId: string, cambios: CambiosItem): Promise<ScheduleItem> {
    const cliente = clienteDe(this.prisma)
    const { count } = await cliente.scheduleItem.updateMany({
      where: { id: itemId, eventId },
      data: {
        ...(cambios.title !== undefined ? { title: cambios.title } : {}),
        ...(cambios.description !== undefined ? { description: cambios.description } : {}),
        ...(cambios.startsAt !== undefined ? { startsAt: cambios.startsAt } : {}),
        ...(cambios.endsAt !== undefined ? { endsAt: cambios.endsAt } : {}),
        ...(cambios.status !== undefined ? { status: cambios.status } : {}),
        ...columnasLugar(cambios.location),
      },
    })
    if (count === 0) throw new ItemDeCronogramaNoEncontradoError()
    const fila = await cliente.scheduleItem.findFirst({ where: { id: itemId, eventId } })
    if (fila === null) throw new ItemDeCronogramaNoEncontradoError()
    return aDominio(fila)
  }

  async eliminar(eventId: string, itemId: string): Promise<boolean> {
    const { count } = await clienteDe(this.prisma).scheduleItem.deleteMany({
      where: { id: itemId, eventId },
    })
    return count > 0
  }

  /** Ver el contrato en el puerto. Sin ids (o sin filas) no bloquea nada. */
  async bloquearItems(eventId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return
    // `$queryRaw` con template tag: los ids van como parámetros (el array como
    // `text[]`), nada se concatena. `ORDER BY id` fija el orden de los bloqueos.
    await clienteDe(this.prisma).$queryRaw`
      SELECT id FROM schedule_items
      WHERE "eventId" = ${eventId}::uuid AND id = ANY(${itemIds}::uuid[])
      ORDER BY id
      FOR UPDATE`
  }

  async listarConAsignaciones(eventId: string): Promise<ItemConAsignaciones[]> {
    const filas = await clienteDe(this.prisma).scheduleItem.findMany({
      where: { eventId },
      include: INCLUIR_ASIGNACIONES,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    })
    return filas.map(conAsignaciones)
  }

  async buscarConAsignaciones(
    eventId: string,
    itemId: string,
  ): Promise<ItemConAsignaciones | null> {
    const fila = await clienteDe(this.prisma).scheduleItem.findFirst({
      where: { id: itemId, eventId },
      include: INCLUIR_ASIGNACIONES,
    })
    return fila === null ? null : conAsignaciones(fila)
  }

  async listarAsignables(eventId: string): Promise<Asignable[]> {
    const filas = await clienteDe(this.prisma).eventVendor.findMany({
      where: { eventId, status: 'BOOKED', vendorProfileId: { not: null } },
      select: {
        id: true,
        category: { select: { name: true } },
        vendorProfile: { select: { businessName: true, userId: true } },
      },
    })
    const lista: Asignable[] = []
    for (const f of filas) {
      if (f.vendorProfile === null) continue
      lista.push({
        eventVendorId: f.id,
        name: f.vendorProfile.businessName,
        categoryName: f.category.name,
        userId: f.vendorProfile.userId,
      })
    }
    return lista.sort(
      (a, b) => porTexto(a.name, b.name) || porTexto(a.eventVendorId, b.eventVendorId),
    )
  }

  /**
   * Altas: pedidos sin fila; bajas: VIGENTES no pedidas. Una fila no vigente
   * (contratación cancelada) no se toca aunque no venga en la lista: el
   * planner sólo ve las vigentes y, si se borrara aquí, el proveedor perdería
   * sus asignaciones al recontratarlo (spec 2026-11-10 §3). Desasignar borra
   * la fila: no hay historial (spec §9).
   */
  async fijarAsignaciones(
    itemId: string,
    eventVendorIds: string[],
    por: string,
  ): Promise<{ altas: string[]; bajas: string[] }> {
    const cliente = clienteDe(this.prisma)
    const [existentes, vigentes] = await Promise.all([
      cliente.scheduleItemVendor.findMany({
        where: { scheduleItemId: itemId },
        select: { eventVendorId: true },
      }),
      cliente.scheduleItemVendor.findMany({
        where: { scheduleItemId: itemId, ...VIGENTE },
        select: { eventVendorId: true },
      }),
    ])
    const existentesIds = new Set(existentes.map((a) => a.eventVendorId))
    const pedidos = new Set(eventVendorIds)
    const altas = [...pedidos].filter((id) => !existentesIds.has(id)).sort(porTexto)
    const bajas = vigentes
      .map((a) => a.eventVendorId)
      .filter((id) => !pedidos.has(id))
      .sort(porTexto)
    if (altas.length > 0) {
      await cliente.scheduleItemVendor.createMany({
        data: altas.map((eventVendorId) => ({
          scheduleItemId: itemId,
          eventVendorId,
          assignedById: por,
        })),
      })
    }
    if (bajas.length > 0) {
      await cliente.scheduleItemVendor.deleteMany({
        where: { scheduleItemId: itemId, eventVendorId: { in: bajas } },
      })
    }
    return { altas, bajas }
  }

  async desconfirmarItem(itemId: string): Promise<void> {
    await clienteDe(this.prisma).scheduleItemVendor.updateMany({
      where: { scheduleItemId: itemId },
      data: { confirmedAt: null },
    })
  }

  async usuariosAsignados(itemId: string): Promise<string[]> {
    const filas = await clienteDe(this.prisma).scheduleItemVendor.findMany({
      where: { scheduleItemId: itemId, ...VIGENTE },
      select: { eventVendor: { select: { vendorProfile: { select: { userId: true } } } } },
    })
    return usuariosDe(filas)
  }

  /**
   * Un elemento por USUARIO, no por contratación: el proveedor con dos
   * contrataciones `BOOKED` es uno en "Vendors Ready" y está listo sólo si
   * todas sus asignaciones vigentes están confirmadas (spec 2026-11-10 §4).
   * `name` es el `businessName` de su ficha y `avatarKey` el de su usuario. Un
   * usuario tiene una sola ficha (`vendor_profiles.userId` es UNIQUE), así que
   * todas sus contrataciones comparten nombre; aun así, si alguna vez
   * difiriera, gana el primero por orden alfabético, igual que en el doble.
   */
  async estadoConfirmaciones(eventId: string): Promise<EstadoProveedor[]> {
    const filas = await clienteDe(this.prisma).scheduleItemVendor.findMany({
      where: { scheduleItem: { eventId }, ...VIGENTE },
      select: {
        confirmedAt: true,
        eventVendor: {
          select: {
            vendorProfile: {
              select: { userId: true, businessName: true, user: { select: { avatarKey: true } } },
            },
          },
        },
      },
    })
    const porUsuario = new Map<string, EstadoProveedor>()
    for (const f of filas) {
      const ficha = f.eventVendor.vendorProfile
      if (ficha === null) continue
      const previo = porUsuario.get(ficha.userId)
      porUsuario.set(ficha.userId, {
        userId: ficha.userId,
        name:
          previo === undefined || porTexto(ficha.businessName, previo.name) < 0
            ? ficha.businessName
            : previo.name,
        avatarKey: ficha.user.avatarKey,
        ready: (previo?.ready ?? true) && f.confirmedAt !== null,
      })
    }
    return [...porUsuario.values()].sort(
      (a, b) => porTexto(a.name, b.name) || porTexto(a.userId, b.userId),
    )
  }

  async pendientesDe(eventId: string, userId: string): Promise<PendienteDeProveedor[]> {
    const filas = await clienteDe(this.prisma).scheduleItem.findMany({
      where: { eventId, vendors: { some: { confirmedAt: null, ...vigentesDe(userId) } } },
      select: { id: true, startsAt: true, endsAt: true },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    })
    return filas.map((f) => ({ itemId: f.id, startsAt: f.startsAt, endsAt: f.endsAt }))
  }

  /**
   * Un solo UPDATE: la comparación con la hora vista va en el WHERE, así que
   * no hay hueco entre leer la hora y escribir la confirmación dentro de esta
   * sentencia. Que el cambio de hora del planner no se cuele entre medias es
   * cosa del caso de uso (bloquea la fila del evento). `endsAt: null` en
   * Prisma es `IS NULL`, que es justo "el ítem sigue sin hora de fin".
   * Alternativa descartada: leer los pendientes actuales y confirmar los que
   * coincidan, que son dos sentencias y abre la carrera que esto cierra.
   */
  async confirmar(eventId: string, userId: string, vistos: PendienteDeProveedor[]): Promise<void> {
    if (vistos.length === 0) return
    await clienteDe(this.prisma).scheduleItemVendor.updateMany({
      where: {
        confirmedAt: null,
        ...vigentesDe(userId),
        OR: vistos.map((v) => ({
          scheduleItemId: v.itemId,
          scheduleItem: { eventId, startsAt: v.startsAt, endsAt: v.endsAt },
        })),
      },
      data: { confirmedAt: new Date() },
    })
  }

  async usuariosConPendientes(eventId: string): Promise<string[]> {
    const filas = await clienteDe(this.prisma).scheduleItemVendor.findMany({
      where: { confirmedAt: null, scheduleItem: { eventId }, ...VIGENTE },
      select: { eventVendor: { select: { vendorProfile: { select: { userId: true } } } } },
    })
    return usuariosDe(filas)
  }

  /**
   * Cronológico por `createdAt` (ms) y, en empate, por id: dos notas del mismo
   * milisegundo salen en orden estable pero no necesariamente el de inserción.
   * Alternativa descartada: una columna serie sólo para desempatar.
   */
  async listarNotas(itemId: string): Promise<NotaDeItem[]> {
    const filas = await clienteDe(this.prisma).scheduleItemNote.findMany({
      where: { scheduleItemId: itemId },
      include: INCLUIR_AUTOR,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return filas.map(aNota)
  }

  async listarNotasDeEvento(eventId: string): Promise<Map<string, NotaDeItem[]>> {
    const filas = await clienteDe(this.prisma).scheduleItemNote.findMany({
      where: { scheduleItem: { eventId } },
      include: INCLUIR_AUTOR,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const porItem = new Map<string, NotaDeItem[]>()
    for (const fila of filas) {
      const nota = aNota(fila)
      porItem.set(nota.itemId, [...(porItem.get(nota.itemId) ?? []), nota])
    }
    return porItem
  }

  async crearNota(itemId: string, authorId: string, body: string): Promise<NotaDeItem> {
    const fila = await clienteDe(this.prisma).scheduleItemNote.create({
      data: { scheduleItemId: itemId, authorId, body },
      include: INCLUIR_AUTOR,
    })
    return aNota(fila)
  }

  async contarNotas(eventId: string): Promise<Map<string, number>> {
    const grupos = await clienteDe(this.prisma).scheduleItemNote.groupBy({
      by: ['scheduleItemId'],
      where: { scheduleItem: { eventId } },
      _count: { _all: true },
    })
    return new Map(grupos.map((g) => [g.scheduleItemId, g._count._all]))
  }

  /**
   * Un solo SELECT con la regla de "vigente" (`VIGENTE`) más el evento
   * `ACTIVE`: el ítem inexistente, la asignación ausente, la contratación
   * cancelada o el evento en borrador dan todos null sin distinguirse, porque
   * el worker sólo necesita saber si avisar (spec 2026-11-10 §5).
   */
  async destinoRecordatorio(
    itemId: string,
    eventVendorId: string,
  ): Promise<DestinoRecordatorio | null> {
    const fila = await clienteDe(this.prisma).scheduleItemVendor.findFirst({
      where: {
        scheduleItemId: itemId,
        eventVendorId,
        ...VIGENTE,
        scheduleItem: { event: { status: 'ACTIVE' } },
      },
      select: {
        scheduleItem: { select: { eventId: true, title: true, status: true, startsAt: true } },
        eventVendor: { select: { vendorProfile: { select: { userId: true } } } },
      },
    })
    const ficha = fila?.eventVendor.vendorProfile
    if (fila === null || ficha === null || ficha === undefined) return null
    return { userId: ficha.userId, ...fila.scheduleItem }
  }

  async asignacionesFuturas(
    eventVendorId: string,
    ahora: Date,
  ): Promise<{ itemId: string; startsAt: Date }[]> {
    const filas = await clienteDe(this.prisma).scheduleItemVendor.findMany({
      where: { eventVendorId, ...VIGENTE, scheduleItem: { startsAt: { gt: ahora } } },
      select: { scheduleItemId: true, scheduleItem: { select: { startsAt: true } } },
    })
    return filas
      .map((f) => ({ itemId: f.scheduleItemId, startsAt: f.scheduleItem.startsAt }))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || porTexto(a.itemId, b.itemId))
  }
}

function aNota(fila: FilaDeNota): NotaDeItem {
  return {
    id: fila.id,
    itemId: fila.scheduleItemId,
    body: fila.body,
    createdAt: fila.createdAt,
    author: { id: fila.author.id, name: fila.author.fullName, avatarKey: fila.author.avatarKey },
  }
}

/** userIds sin repetir y ordenados de unas asignaciones (las externas no tienen). */
function usuariosDe(
  filas: { eventVendor: { vendorProfile: { userId: string } | null } }[],
): string[] {
  const usuarios = new Set<string>()
  for (const f of filas) {
    if (f.eventVendor.vendorProfile !== null) usuarios.add(f.eventVendor.vendorProfile.userId)
  }
  return [...usuarios].sort(porTexto)
}

function conAsignaciones(fila: FilaConAsignaciones): ItemConAsignaciones {
  const vendors: AsignacionVista[] = fila.vendors
    .map((a) => ({
      eventVendorId: a.eventVendorId,
      name: a.eventVendor.vendorProfile?.businessName ?? '',
      categoryName: a.eventVendor.category.name,
      confirmed: a.confirmedAt !== null,
    }))
    .sort((a, b) => porTexto(a.name, b.name) || porTexto(a.eventVendorId, b.eventVendorId))
  return { ...aDominio(fila), vendors }
}

function aDominio(fila: Fila): ScheduleItem {
  const tieneLugar =
    fila.locationAddress !== null && fila.locationLat !== null && fila.locationLng !== null
  return {
    id: fila.id,
    eventId: fila.eventId,
    title: fila.title,
    description: fila.description,
    startsAt: fila.startsAt,
    endsAt: fila.endsAt,
    location: tieneLugar
      ? {
          name: fila.locationName,
          address: fila.locationAddress ?? '',
          lat: Number(fila.locationLat),
          lng: Number(fila.locationLng),
          mapboxId: fila.locationMapboxId,
        }
      : null,
    status: fila.status,
    createdAt: fila.createdAt,
    updatedAt: fila.updatedAt,
  }
}
