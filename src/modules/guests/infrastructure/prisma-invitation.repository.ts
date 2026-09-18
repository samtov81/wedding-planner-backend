import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'

import type {
  DatosCrearInvitacion,
  InvitacionCompleta,
  InvitationRepository,
} from '../application/invitation.repository'
import { InvitadoNoEncontradoError } from '../domain/guest-errors'
import type { InvitationStatus } from '../domain/invitation'

/** El `include` es el mismo para las dos lecturas: una sola forma de fila. */
const CON_INVITADO_Y_EVENTO = {
  guest: { include: { event: true } },
} satisfies Prisma.GuestInvitationInclude

type FilaCompleta = Prisma.GuestInvitationGetPayload<{ include: typeof CON_INVITADO_Y_EVENTO }>

@Injectable()
export class PrismaInvitationRepository implements InvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async crear(datos: DatosCrearInvitacion): Promise<{ id: string }> {
    try {
      const fila = await this.prisma.guestInvitation.create({
        data: {
          guestId: datos.guestId,
          tokenHash: datos.tokenHash,
          expiresAt: datos.expiresAt,
        },
        select: { id: true },
      })
      return { id: fila.id }
    } catch (error) {
      throw traducir(error)
    }
  }

  async buscarConInvitadoYEvento(id: string): Promise<InvitacionCompleta | null> {
    const fila = await this.prisma.guestInvitation.findUnique({
      where: { id },
      include: CON_INVITADO_Y_EVENTO,
    })
    return fila === null ? null : aInvitacion(fila)
  }

  async marcarEnviada(id: string, providerMessageId: string): Promise<void> {
    // Estado e id del proveedor en la MISMA escritura: dos updates dejarían una
    // ventana en la que el webhook llega a una invitación sin `resendMessageId`
    // y no sabe a quién pertenece.
    await this.prisma.guestInvitation.update({
      where: { id },
      data: { status: 'SENT', sentAt: new Date(), resendMessageId: providerMessageId },
    })
  }

  async buscarPorHash(tokenHash: string): Promise<InvitacionCompleta | null> {
    const fila = await this.prisma.guestInvitation.findUnique({
      where: { tokenHash },
      include: CON_INVITADO_Y_EVENTO,
    })
    return fila === null ? null : aInvitacion(fila)
  }

  async marcarRespondida(id: string): Promise<void> {
    await this.prisma.guestInvitation.update({
      where: { id },
      data: { status: 'RESPONDED', respondedAt: new Date() },
    })
  }

  async caducar(id: string): Promise<void> {
    // `updateMany`: la invitación pudo borrarse; caducar lo inexistente no es error.
    await this.prisma.guestInvitation.updateMany({
      where: { id },
      data: { expiresAt: new Date() },
    })
  }

  async actualizarEstadoPorMessageId(messageId: string, estado: InvitationStatus): Promise<void> {
    // `updateMany`: un webhook puede llegar para un id que ya no existe, y eso
    // afecta a 0 filas en vez de lanzar. No es un error que el proveedor nos
    // cuente algo de una invitación borrada.
    await this.prisma.guestInvitation.updateMany({
      where: { resendMessageId: messageId },
      data: { status: estado },
    })
  }
}

/** La fila de Prisma no sale de `infrastructure/`. */
function aInvitacion(fila: FilaCompleta): InvitacionCompleta {
  return {
    id: fila.id,
    status: fila.status,
    expiresAt: fila.expiresAt,
    respondedAt: fila.respondedAt,
    resendMessageId: fila.resendMessageId,
    guest: {
      id: fila.guest.id,
      eventId: fila.guest.eventId,
      name: fila.guest.name,
      email: fila.guest.email,
    },
    event: {
      id: fila.guest.event.id,
      name: fila.guest.event.name,
      weddingDate: fila.guest.event.weddingDate,
    },
  }
}

/**
 * Un error crudo de Prisma NO es un `DomainError` y saldría como 500. `P2003`
 * es la clave foránea: el invitado se borró entre la lectura y este `create`,
 * así que el 404 del invitado es la respuesta honesta.
 * Mismo precedente que `PrismaGuestRepository`: se compara por CÓDIGO.
 */
function traducir(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
    return new InvitadoNoEncontradoError()
  }
  return error
}
