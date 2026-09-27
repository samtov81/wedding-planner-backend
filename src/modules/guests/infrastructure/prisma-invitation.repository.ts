import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe } from '@/modules/database/transaccion'

import type {
  DatosCrearInvitacion,
  InvitacionAvanzada,
  InvitacionCompleta,
  InvitationRepository,
} from '../application/invitation.repository'
import { InvitadoNoEncontradoError } from '../domain/guest-errors'
import { estadosQuePuedenAvanzarA, type InvitationStatus } from '../domain/invitation'

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

  async marcarEnviada(id: string, providerMessageId: string | null): Promise<void> {
    // Estado e id del proveedor en la MISMA escritura: dos updates dejarían una
    // ventana en la que el webhook llega a una invitación sin `resendMessageId`
    // y no sabe a quién pertenece.
    //
    // `updateMany` con la guarda de estado en el `WHERE` (ruling C21): sólo
    // avanza desde QUEUED. Un reintento que llega tarde —el invitado ya
    // respondió, o el webhook ya escribió DELIVERED— afecta a 0 filas en vez de
    // pisar el estado. Misma regla y mismo motivo que `actualizarEstadoPorMessageId`.
    await this.prisma.guestInvitation.updateMany({
      where: { id, status: { in: estadosQuePuedenAvanzarA('SENT') } },
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

  async marcarRespondida(id: string, ahora: Date): Promise<boolean> {
    // Sólo la caducidad va en el `WHERE`, en cualquier estado: el invitado
    // puede cambiar su respuesta (bloque A §2). Un reenvío o un cambio de email
    // que caduque el token entre la lectura del caso de uso y este UPDATE lo
    // deja en 0 filas: Postgres reevalúa el `WHERE` contra la fila ya caducada.
    //
    // `clienteDe`: se llama dentro de la unidad de trabajo del RSVP.
    const { count } = await clienteDe(this.prisma).guestInvitation.updateMany({
      where: { id, expiresAt: { gt: ahora } },
      data: { status: 'RESPONDED', respondedAt: ahora },
    })
    return count === 1
  }

  async caducar(id: string): Promise<void> {
    // `updateMany`: la invitación pudo borrarse; caducar lo inexistente no es error.
    await this.prisma.guestInvitation.updateMany({
      where: { id },
      data: { expiresAt: new Date() },
    })
  }

  async caducarVigentesDe(guestId: string, ahora: Date): Promise<void> {
    // Sin filtrar por estado: un token RESPONDED también puede cambiar el RSVP
    // (bloque A §2), así que también muere.
    //
    // `clienteDe`: `UpdateGuestUseCase` lo llama dentro de la unidad de trabajo
    // del cambio de email.
    await clienteDe(this.prisma).guestInvitation.updateMany({
      where: { guestId, expiresAt: { gt: ahora } },
      data: { expiresAt: ahora },
    })
  }

  async actualizarEstadoPorMessageId(
    messageId: string,
    estado: InvitationStatus,
  ): Promise<InvitacionAvanzada[]> {
    // Un webhook puede llegar para un id que ya no existe, y eso afecta a 0
    // filas en vez de lanzar. No es un error que el proveedor nos cuente algo
    // de una invitación borrada.
    //
    // La monotonía va en el `WHERE`, no en una lectura previa: es UN solo
    // `UPDATE ... WHERE status = ANY(...)`. Si dos webhooks del mismo correo
    // llegan a la vez, Postgres serializa las dos escrituras sobre la fila y
    // reevalúa el `WHERE` de la segunda contra el valor ya escrito por la
    // primera (READ COMMITTED), así que un `delivered` rezagado encuentra
    // BOUNCED y afecta a 0 filas. Un "leer y comparar" en el caso de uso no
    // tendría esa garantía.
    //
    // SQL y no `updateMany` (Tarea 15): el aviso en tiempo real necesita saber
    // QUÉ filas avanzaron, y `updateMany` sólo devuelve cuántas. `RETURNING`
    // devuelve exactamente las que cumplieron el `WHERE` en esta escritura.
    // `$queryRaw` con template tag: todo valor va como parámetro, nada se
    // concatena.
    const desde = estadosQuePuedenAvanzarA(estado)
    return await this.prisma.$queryRaw<InvitacionAvanzada[]>`
      UPDATE guest_invitations AS gi
      SET status = ${estado}::"InvitationStatus"
      FROM guests AS g
      WHERE g.id = gi."guestId"
        AND gi."resendMessageId" = ${messageId}
        AND gi.status = ANY(${desde}::"InvitationStatus"[])
      RETURNING gi.id::text AS "invitationId", gi."guestId"::text AS "guestId",
        g."eventId"::text AS "eventId"
    `
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
      rsvpDeadlineDays: fila.guest.event.rsvpDeadlineDays,
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
