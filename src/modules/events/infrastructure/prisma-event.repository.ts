import { Injectable } from '@nestjs/common'
import type { Event as EventFila, Prisma } from '@prisma/client'

import { clienteDe } from '@/modules/database/transaccion'
import { PrismaService } from '@/modules/database/prisma.service'
import type { Ubicacion } from '@/shared/domain'

import type {
  CambiosEvento,
  CambiosMembresia,
  DatosInvitacion,
  DatosNuevoEvento,
  EventoAccesible,
  EventRepository,
  InvitacionPendiente,
  MembresiaGestionable,
  MembresiaPersistida,
  MiembroPersistido,
} from '../application/event.repository'
import type { Event } from '../domain/event'
import {
  CONTRATACION_CON_ACCESO,
  MEMBRESIA_CON_ACCESO,
  type EventRole,
  type MembershipStatus,
} from '../domain/event-access'
import { EventoNoEncontradoError } from '../domain/event-errors'

/** Estados que se gestionan: una REVOKED no se lista ni se toca. */
const VIVAS = ['INVITED', 'ACTIVE'] as const satisfies readonly MembershipStatus[]

/** Conteos que alimentan `completitud` sin una consulta por evento. */
const CON_CONTEOS = {
  _count: { select: { scheduleItems: true, vendors: true } },
} satisfies Prisma.EventInclude

type FilaConConteos = EventFila & { _count: { scheduleItems: number; vendors: number } }

/** `undefined` no toca las columnas; `null` las vacía las cinco a la vez. */
function columnasVenue(venue: Ubicacion | null | undefined): Prisma.EventUncheckedUpdateInput {
  if (venue === undefined) return {}
  if (venue === null) {
    return {
      venueName: null,
      venueAddress: null,
      venueLat: null,
      venueLng: null,
      venueMapboxId: null,
    }
  }
  return {
    venueName: venue.name,
    venueAddress: venue.address,
    venueLat: venue.lat,
    venueLng: venue.lng,
    venueMapboxId: venue.mapboxId,
  }
}

@Injectable()
export class PrismaEventRepository implements EventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async buscarMembresiaActiva(
    eventId: string,
    userId: string,
  ): Promise<{ role: EventRole; owner: boolean; budgetView: boolean } | null> {
    // El estado se filtra en el WHERE, no después: así no existe la ventana en
    // la que alguien lea la fila y se olvide de mirar el `status`.
    const fila = await this.prisma.eventMembership.findFirst({
      where: { eventId, userId, status: MEMBRESIA_CON_ACCESO },
      select: {
        role: true,
        event: { select: { ownerId: true } },
        budgetGrant: { select: { id: true } },
      },
    })
    return fila === null
      ? null
      : {
          role: fila.role,
          owner: fila.event.ownerId === userId,
          budgetView: fila.budgetGrant !== null,
        }
  }

  async buscarContratacionReservada(
    eventId: string,
    userId: string,
  ): Promise<{ id: string } | null> {
    // `vendorProfile: { userId }` exige que la ficha exista: un EventVendor
    // externo tiene `vendorProfileId = null` y nunca casa con este WHERE.
    const fila = await this.prisma.eventVendor.findFirst({
      where: {
        eventId,
        status: CONTRATACION_CON_ACCESO,
        vendorProfile: { userId },
        event: { status: 'ACTIVE' },
      },
      select: { id: true },
    })
    return fila === null ? null : { id: fila.id }
  }

  async crearConMembresia(datos: DatosNuevoEvento): Promise<Event> {
    return await this.prisma.$transaction(async (tx) => {
      const evento = await tx.event.create({
        data: {
          name: datos.name,
          ownerId: datos.ownerId,
          ...(datos.weddingDate !== undefined ? { weddingDate: datos.weddingDate } : {}),
          ...(datos.timezone !== undefined ? { timezone: datos.timezone } : {}),
          ...(datos.currency !== undefined ? { currency: datos.currency } : {}),
          ...(datos.totalBudget !== undefined ? { totalBudget: datos.totalBudget } : {}),
          ...(columnasVenue(datos.venue) as Partial<Prisma.EventUncheckedCreateInput>),
          ...(datos.rsvpDeadlineDays !== undefined
            ? { rsvpDeadlineDays: datos.rsvpDeadlineDays }
            : {}),
        },
        include: CON_CONTEOS,
      })
      await tx.eventMembership.create({
        // Con el MISMO estado que concede acceso: si mañana cambiara cuál es,
        // el creador no puede quedarse fuera de su propio evento.
        data: {
          eventId: evento.id,
          userId: datos.ownerId,
          role: 'COUPLE',
          status: MEMBRESIA_CON_ACCESO,
        },
      })
      return this.aDominio(evento)
    })
  }

  async actualizar(eventId: string, cambios: CambiosEvento): Promise<Event> {
    // `updateMany` + relectura: un `update` sobre un id inexistente lanza
    // P2025 crudo (500); así el 404 es de dominio.
    const cliente = clienteDe(this.prisma)
    const { count } = await cliente.event.updateMany({
      where: { id: eventId },
      data: {
        ...(cambios.name !== undefined ? { name: cambios.name } : {}),
        ...(cambios.status !== undefined ? { status: cambios.status } : {}),
        ...(cambios.weddingDate !== undefined ? { weddingDate: cambios.weddingDate } : {}),
        ...(cambios.timezone !== undefined ? { timezone: cambios.timezone } : {}),
        ...(cambios.currency !== undefined ? { currency: cambios.currency } : {}),
        ...(cambios.totalBudget !== undefined ? { totalBudget: cambios.totalBudget } : {}),
        ...(columnasVenue(cambios.venue) as Prisma.EventUpdateManyMutationInput),
      },
    })
    if (count === 0) throw new EventoNoEncontradoError()
    const fila = await cliente.event.findUnique({ where: { id: eventId }, include: CON_CONTEOS })
    if (fila === null) throw new EventoNoEncontradoError()
    return this.aDominio(fila)
  }

  async publicarSiCompleto(eventId: string): Promise<Event | null> {
    // El `WHERE` repite `camposFaltantesParaPublicar`: si un PATCH concurrente
    // vació alguno de estos campos entre el check del caso de uso y esta
    // escritura, `count` da 0 y no hay UPDATE que deshacer.
    const cliente = clienteDe(this.prisma)
    const { count } = await cliente.event.updateMany({
      where: {
        id: eventId,
        status: 'DRAFT',
        weddingDate: { not: null },
        totalBudget: { not: null },
        venueAddress: { not: null },
        venueLat: { not: null },
        venueLng: { not: null },
      },
      data: { status: 'ACTIVE' },
    })
    if (count === 0) return null
    const fila = await cliente.event.findUnique({ where: { id: eventId }, include: CON_CONTEOS })
    return fila === null ? null : this.aDominio(fila)
  }

  async listarAccesiblesPor(userId: string): Promise<EventoAccesible[]> {
    const filas = await this.prisma.event.findMany({
      where: {
        OR: [
          { memberships: { some: { userId, status: MEMBRESIA_CON_ACCESO } } },
          {
            status: 'ACTIVE',
            vendors: { some: { status: CONTRATACION_CON_ACCESO, vendorProfile: { userId } } },
          },
        ],
      },
      include: {
        ...CON_CONTEOS,
        // `(eventId, userId)` es único: 0 o 1 filas.
        memberships: {
          where: { userId, status: MEMBRESIA_CON_ACCESO },
          select: { budgetGrant: { select: { id: true } } },
        },
      },
      // Borradores sin fecha al final; `createdAt` desempata de forma estable.
      orderBy: [
        { weddingDate: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
    })
    return filas.map(({ memberships, ...fila }) => ({
      evento: this.aDominio(fila),
      budgetView: memberships[0]?.budgetGrant != null,
    }))
  }

  async buscarPorId(eventId: string): Promise<Event | null> {
    const fila = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: CON_CONTEOS,
    })
    return fila === null ? null : this.aDominio(fila)
  }

  async buscarMembresia(eventId: string, userId: string): Promise<MembresiaPersistida | null> {
    const fila = await this.prisma.eventMembership.findUnique({
      where: { eventId_userId: { eventId, userId } },
      select: { id: true, role: true, status: true },
    })
    return fila === null ? null : { id: fila.id, role: fila.role, status: fila.status }
  }

  async invitarMiembro(datos: DatosInvitacion): Promise<MembresiaPersistida> {
    return await this.prisma.$transaction(async (tx) => {
      // `upsert` y no `create`: (eventId, userId) es único, así que volver a
      // invitar a alguien REVOKED tiene que reutilizar su fila. El caso de uso
      // ya ha rechazado a quien sigue ACTIVE o INVITED.
      const membresia = await tx.eventMembership.upsert({
        where: { eventId_userId: { eventId: datos.eventId, userId: datos.userId } },
        create: {
          eventId: datos.eventId,
          userId: datos.userId,
          role: datos.role,
          status: 'INVITED',
          invitedById: datos.invitedById,
        },
        update: { role: datos.role, status: 'INVITED', invitedById: datos.invitedById },
        select: { id: true, role: true, status: true },
      })

      // Una reinvitación nace sin presupuesto, aunque una carrera grant/revocar
      // hubiera dejado un grant colgado de la fila REVOKED que reutilizamos.
      await tx.eventBudgetGrant.deleteMany({ where: { membershipId: membresia.id } })

      await tx.auditLog.create({
        data: {
          actorUserId: datos.invitedById,
          eventId: datos.eventId,
          action: 'event.member.invited',
          target: `user:${datos.userId}`,
          metadata: { role: datos.role },
        },
      })

      return { id: membresia.id, role: membresia.role, status: membresia.status }
    })
  }

  async listarMiembros(eventId: string): Promise<MiembroPersistido[]> {
    const filas = await this.prisma.eventMembership.findMany({
      where: { eventId, status: { in: [...VIVAS] } },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        user: { select: { fullName: true, email: true } },
        event: { select: { ownerId: true } },
        budgetGrant: { select: { id: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const miembros = filas.map((f) => ({
      id: f.id,
      userId: f.userId,
      fullName: f.user.fullName,
      email: f.user.email,
      role: f.role,
      // El `where` sólo deja pasar estos dos.
      status: f.status as 'INVITED' | 'ACTIVE',
      owner: f.event.ownerId === f.userId,
      budgetView: f.budgetGrant !== null,
    }))
    // Creador primero; el resto conserva el orden de la consulta (sort estable).
    return miembros.sort((a, b) => Number(b.owner) - Number(a.owner))
  }

  async buscarMembresiaPorId(
    eventId: string,
    membershipId: string,
  ): Promise<MembresiaGestionable | null> {
    const f = await this.prisma.eventMembership.findFirst({
      where: { id: membershipId, eventId },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        event: { select: { ownerId: true } },
        budgetGrant: { select: { id: true } },
      },
    })
    return f === null
      ? null
      : {
          id: f.id,
          userId: f.userId,
          role: f.role,
          status: f.status,
          owner: f.event.ownerId === f.userId,
          budgetView: f.budgetGrant !== null,
        }
  }

  async actualizarMembresia(
    eventId: string,
    membershipId: string,
    cambios: CambiosMembresia,
    actorId: string,
  ): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      // `updatedAt` explícito: con `data` vacío (sólo cambia el grant) Prisma
      // no emitiría UPDATE y no habría ni bloqueo ni comprobación de estado.
      const { count } = await tx.eventMembership.updateMany({
        where: { id: membershipId, eventId, status: { in: [...VIVAS] } },
        data: {
          updatedAt: new Date(),
          ...(cambios.role !== undefined ? { role: cambios.role } : {}),
        },
      })
      if (count === 0) return false

      if (cambios.budgetView === true) {
        await tx.eventBudgetGrant.upsert({
          where: { membershipId },
          create: { membershipId, grantedById: actorId },
          update: {},
        })
      } else if (cambios.budgetView === false) {
        await tx.eventBudgetGrant.deleteMany({ where: { membershipId } })
      }

      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          eventId,
          action: 'event.member.updated',
          target: `membership:${membershipId}`,
          metadata: {
            ...(cambios.role !== undefined ? { role: cambios.role } : {}),
            ...(cambios.budgetView !== undefined ? { budgetView: cambios.budgetView } : {}),
          },
        },
      })
      return true
    })
  }

  async revocarMembresia(
    eventId: string,
    membershipId: string,
    actorId: string,
    motivo: 'revoked' | 'declined',
  ): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.eventMembership.updateMany({
        where: { id: membershipId, eventId, status: { in: [...VIVAS] } },
        data: { status: 'REVOKED' },
      })
      if (count === 0) return false
      await tx.eventBudgetGrant.deleteMany({ where: { membershipId } })
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          eventId,
          action: `event.member.${motivo}`,
          target: `membership:${membershipId}`,
        },
      })
      return true
    })
  }

  async aceptarInvitacion(eventId: string, userId: string): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.eventMembership.updateMany({
        where: { eventId, userId, status: 'INVITED' },
        data: { status: MEMBRESIA_CON_ACCESO },
      })
      if (count === 0) return false
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          eventId,
          action: 'event.member.accepted',
          target: `user:${userId}`,
        },
      })
      return true
    })
  }

  async listarInvitacionesPendientes(userId: string): Promise<InvitacionPendiente[]> {
    const filas = await this.prisma.eventMembership.findMany({
      where: { userId, status: 'INVITED' },
      select: {
        id: true,
        eventId: true,
        role: true,
        invitedById: true,
        event: { select: { name: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    })
    // `invitedById` no tiene relación en el esquema: una consulta para todos.
    const ids = [...new Set(filas.flatMap((f) => (f.invitedById === null ? [] : [f.invitedById])))]
    const quienes = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    })
    const nombre = new Map(quienes.map((u) => [u.id, u.fullName]))
    return filas.map((f) => ({
      membershipId: f.id,
      eventId: f.eventId,
      eventName: f.event.name,
      role: f.role,
      invitedByName: f.invitedById === null ? null : (nombre.get(f.invitedById) ?? null),
    }))
  }

  /** La fila de Prisma no sale de infrastructure/: el dominio ve su `Event`. */
  private aDominio(fila: FilaConConteos): Event {
    const tieneVenue =
      fila.venueAddress !== null && fila.venueLat !== null && fila.venueLng !== null
    return {
      id: fila.id,
      name: fila.name,
      status: fila.status,
      weddingDate: fila.weddingDate,
      timezone: fila.timezone,
      currency: fila.currency,
      totalBudget: fila.totalBudget === null ? null : fila.totalBudget.toFixed(2),
      // Una dirección sin coordenadas (la migrada de `venueLocation`) no es un
      // venue publicable: se expone como null y el wizard pide elegirla en el mapa.
      venue: tieneVenue
        ? {
            name: fila.venueName,
            address: fila.venueAddress ?? '',
            lat: Number(fila.venueLat),
            lng: Number(fila.venueLng),
            mapboxId: fila.venueMapboxId,
          }
        : null,
      rsvpDeadlineDays: fila.rsvpDeadlineDays,
      ownerId: fila.ownerId,
      conteos: { scheduleItems: fila._count.scheduleItems, vendors: fila._count.vendors },
      createdAt: fila.createdAt,
      updatedAt: fila.updatedAt,
    }
  }
}
