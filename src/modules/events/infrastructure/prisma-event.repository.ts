import { Injectable } from '@nestjs/common'
import type { Event as EventFila, Prisma } from '@prisma/client'

import { clienteDe } from '@/modules/database/transaccion'
import { PrismaService } from '@/modules/database/prisma.service'
import type { Ubicacion } from '@/shared/domain'

import type {
  CambiosEvento,
  DatosInvitacion,
  DatosNuevoEvento,
  EventRepository,
  MembresiaPersistida,
} from '../application/event.repository'
import type { Event } from '../domain/event'
import {
  CONTRATACION_CON_ACCESO,
  MEMBRESIA_CON_ACCESO,
  type EventRole,
} from '../domain/event-access'
import { EventoNoEncontradoError } from '../domain/event-errors'

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
  ): Promise<{ role: EventRole; owner: boolean } | null> {
    // El estado se filtra en el WHERE, no después: así no existe la ventana en
    // la que alguien lea la fila y se olvide de mirar el `status`.
    const fila = await this.prisma.eventMembership.findFirst({
      where: { eventId, userId, status: MEMBRESIA_CON_ACCESO },
      select: { role: true, event: { select: { ownerId: true } } },
    })
    return fila === null ? null : { role: fila.role, owner: fila.event.ownerId === userId }
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

  async listarAccesiblesPor(userId: string): Promise<Event[]> {
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
      include: CON_CONTEOS,
      // Borradores sin fecha al final; `createdAt` desempata de forma estable.
      orderBy: [
        { weddingDate: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
    })
    return filas.map((fila) => this.aDominio(fila))
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
