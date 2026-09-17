import { Injectable } from '@nestjs/common'
import type { Event as EventFila } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'

import type {
  DatosInvitacion,
  DatosNuevoEvento,
  EventRepository,
  MembresiaPersistida,
} from '../application/event.repository'
import type { Event } from '../domain/event'
import type { EventRole } from '../domain/event-access'

@Injectable()
export class PrismaEventRepository implements EventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async buscarMembresiaActiva(
    eventId: string,
    userId: string,
  ): Promise<{ role: EventRole } | null> {
    // El estado se filtra en el WHERE, no después: así no existe la ventana en
    // la que alguien lea la fila y se olvide de mirar el `status`.
    const fila = await this.prisma.eventMembership.findFirst({
      where: { eventId, userId, status: 'ACTIVE' },
      select: { role: true },
    })
    return fila === null ? null : { role: fila.role }
  }

  async buscarContratacionReservada(
    eventId: string,
    userId: string,
  ): Promise<{ id: string } | null> {
    // `vendorProfile: { userId }` exige que la ficha exista: un EventVendor
    // externo tiene `vendorProfileId = null` y nunca casa con este WHERE.
    const fila = await this.prisma.eventVendor.findFirst({
      where: { eventId, status: 'BOOKED', vendorProfile: { userId } },
      select: { id: true },
    })
    return fila === null ? null : { id: fila.id }
  }

  async crearConMembresia(datos: DatosNuevoEvento): Promise<Event> {
    return await this.prisma.$transaction(async (tx) => {
      const evento = await tx.event.create({
        data: { name: datos.name, weddingDate: datos.weddingDate, ownerId: datos.ownerId },
      })
      await tx.eventMembership.create({
        data: { eventId: evento.id, userId: datos.ownerId, role: 'COUPLE', status: 'ACTIVE' },
      })
      return this.aDominio(evento)
    })
  }

  async listarAccesiblesPor(userId: string): Promise<Event[]> {
    const filas = await this.prisma.event.findMany({
      where: {
        OR: [
          { memberships: { some: { userId, status: 'ACTIVE' } } },
          { vendors: { some: { status: 'BOOKED', vendorProfile: { userId } } } },
        ],
      },
      orderBy: [{ weddingDate: 'asc' }, { id: 'asc' }],
    })
    return filas.map((fila) => this.aDominio(fila))
  }

  async buscarPorId(eventId: string): Promise<Event | null> {
    const fila = await this.prisma.event.findUnique({ where: { id: eventId } })
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
  private aDominio(fila: EventFila): Event {
    return {
      id: fila.id,
      name: fila.name,
      weddingDate: fila.weddingDate,
      timezone: fila.timezone,
      venueLocation: fila.venueLocation,
      ownerId: fila.ownerId,
      createdAt: fila.createdAt,
      updatedAt: fila.updatedAt,
    }
  }
}
