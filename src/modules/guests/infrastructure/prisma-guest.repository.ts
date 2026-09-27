import { Injectable } from '@nestjs/common'
import { Prisma, type Guest as GuestFila } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe } from '@/modules/database/transaccion'

import type {
  CambiosInvitado,
  DatosCrearInvitado,
  GuestFilters,
  GuestRepository,
} from '../application/guest.repository'
import type { Guest, RsvpStatus } from '../domain/guest'
import { EmailDuplicadoError, InvitadoNoEncontradoError } from '../domain/guest-errors'
import { encodeCursor, type CursorPage, type CursorValue } from '@/shared/domain'

/** Orden ÚNICO de todo el módulo: el mismo que respalda el índice del esquema. */
const ORDEN_ESTABLE = [
  { createdAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.GuestOrderByWithRelationInput[]

@Injectable()
export class PrismaGuestRepository implements GuestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listar(
    eventId: string,
    filtros: GuestFilters,
    cursor: CursorValue | null,
    limite: number,
  ): Promise<CursorPage<Guest>> {
    const where: Prisma.GuestWhereInput = {
      eventId,
      ...(filtros.rsvp !== undefined ? { rsvp: filtros.rsvp } : {}),
      ...(filtros.group !== undefined ? { group: filtros.group } : {}),
      ...(filtros.q !== undefined
        ? {
            OR: [
              { name: { contains: filtros.q, mode: 'insensitive' } },
              { email: { contains: filtros.q, mode: 'insensitive' } },
            ],
          }
        : {}),
      // Comparación lexicográfica de la tupla (createdAt, id): "estrictamente
      // posterior al cursor". Con createdAt solo, dos invitados creados en el
      // mismo milisegundo harían que uno se perdiera entre páginas.
      //
      // Va dentro de un AND propio, no como `OR` suelto: el filtro `q` ya usa
      // `OR` en el mismo objeto y el segundo sobrescribiría al primero — el
      // cursor dejaría de aplicarse en cuanto alguien buscara algo.
      ...(cursor !== null
        ? {
            AND: [
              {
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                ],
              },
            ],
          }
        : {}),
    }

    // Se pide uno de más: si viene, hay página siguiente. Evita el COUNT(*)
    // adicional, que en una tabla grande cuesta más que la propia consulta.
    const filas = await this.prisma.guest.findMany({
      where,
      orderBy: ORDEN_ESTABLE,
      take: limite + 1,
    })

    const hayMas = filas.length > limite
    const items = (hayMas ? filas.slice(0, limite) : filas).map((fila) => aInvitado(fila))
    const ultimo = items.at(-1)

    return {
      items,
      nextCursor: hayMas && ultimo !== undefined ? encodeCursor(ultimo) : null,
    }
  }

  async contarPorEstado(eventId: string): Promise<Record<RsvpStatus, number>> {
    // GROUP BY, no una columna de contador. Una columna se desincroniza en
    // cuanto alguien actualiza un RSVP por una vía que no la mantiene.
    const grupos = await this.prisma.guest.groupBy({
      by: ['rsvp'],
      where: { eventId },
      _count: { _all: true },
    })

    const base: Record<RsvpStatus, number> = { CONFIRMED: 0, PENDING: 0, DECLINED: 0 }
    for (const grupo of grupos) base[grupo.rsvp] = grupo._count._all

    return base
  }

  async sumarAcompanantesConfirmados(eventId: string): Promise<number> {
    const suma = await this.prisma.guest.aggregate({
      where: { eventId, rsvp: 'CONFIRMED' },
      _sum: { companionsConfirmed: true },
    })
    return suma._sum.companionsConfirmed ?? 0
  }

  async crear(datos: DatosCrearInvitado): Promise<Guest> {
    try {
      const fila = await this.prisma.guest.create({ data: aFilaNueva(datos) })
      return aInvitado(fila)
    } catch (error) {
      throw traducir(error)
    }
  }

  async crearVarios(datos: DatosCrearInvitado[]): Promise<number> {
    // Un solo INSERT multi-fila: Postgres lo aplica entero o nada, sin
    // transacción explícita. `clienteDe` por si algún día lo llama una unidad
    // de trabajo más grande.
    try {
      const { count } = await clienteDe(this.prisma).guest.createMany({
        data: datos.map((d) => aFilaNueva(d)),
      })
      return count
    } catch (error) {
      throw traducir(error)
    }
  }

  async emailsExistentes(eventId: string, emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set()
    const filas = await this.prisma.guest.findMany({
      where: { eventId, email: { in: emails, mode: 'insensitive' } },
      select: { email: true },
    })
    return new Set(filas.flatMap((f) => (f.email === null ? [] : [f.email.toLowerCase()])))
  }

  async buscar(eventId: string, guestId: string): Promise<Guest | null> {
    const fila = await this.prisma.guest.findFirst({ where: { id: guestId, eventId } })
    return fila === null ? null : aInvitado(fila)
  }

  async actualizar(eventId: string, guestId: string, cambios: CambiosInvitado): Promise<Guest> {
    // `updateMany` + relectura, no `update`: `update` exige clave única (`id`)
    // y con sólo `id` no se comprueba que la fila sea de ESTE evento. El caso
    // de uso ya lo comprobó, pero repetir el filtro evita que una llamada
    // futura directa al repositorio se lo salte.
    //
    // `clienteDe`: el RSVP público lo llama dentro de una unidad de trabajo, y
    // la escritura Y la relectura tienen que ir por la conexión de esa
    // transacción (ver `UnidadDeTrabajo`).
    const cliente = clienteDe(this.prisma)
    try {
      await cliente.guest.updateMany({
        where: { id: guestId, eventId },
        data: {
          ...(cambios.name !== undefined ? { name: cambios.name } : {}),
          ...(cambios.email !== undefined ? { email: cambios.email } : {}),
          ...(cambios.group !== undefined ? { group: cambios.group } : {}),
          ...(cambios.rsvp !== undefined ? { rsvp: cambios.rsvp } : {}),
          ...(cambios.dietary !== undefined ? { dietary: cambios.dietary } : {}),
          ...(cambios.companionsAllowed !== undefined
            ? { companionsAllowed: cambios.companionsAllowed }
            : {}),
          ...(cambios.companionsConfirmed !== undefined
            ? { companionsConfirmed: cambios.companionsConfirmed }
            : {}),
        },
      })
    } catch (error) {
      throw traducir(error)
    }

    // `findFirst`, no `findFirstOrThrow`: si la fila desapareció ENTRE el
    // `updateMany` y esta relectura (borrado concurrente), lanzar un P2025
    // crudo sería un 500. El caso de uso ya comprobó que existía antes de
    // escribir; aquí se repite el mismo 404 de dominio para la ventana entre
    // medias.
    const fila = await cliente.guest.findFirst({ where: { id: guestId, eventId } })
    if (fila === null) throw new InvitadoNoEncontradoError()
    return aInvitado(fila)
  }

  async borrar(eventId: string, guestId: string): Promise<void> {
    await this.prisma.guest.deleteMany({ where: { id: guestId, eventId } })
  }

  async listarTodos(eventId: string): Promise<Guest[]> {
    const filas = await this.prisma.guest.findMany({ where: { eventId }, orderBy: ORDEN_ESTABLE })
    return filas.map((fila) => aInvitado(fila))
  }
}

/** La fila de Prisma no sale de `infrastructure/`: `updatedAt` no es del puerto. */
function aInvitado(fila: GuestFila): Guest {
  return {
    id: fila.id,
    eventId: fila.eventId,
    name: fila.name,
    email: fila.email,
    group: fila.group,
    rsvp: fila.rsvp,
    dietary: fila.dietary,
    companionsAllowed: fila.companionsAllowed,
    companionsConfirmed: fila.companionsConfirmed,
    createdAt: fila.createdAt,
  }
}

function aFilaNueva(datos: DatosCrearInvitado): Prisma.GuestCreateManyInput {
  return {
    eventId: datos.eventId,
    name: datos.name,
    email: datos.email,
    group: datos.group,
    dietary: datos.dietary,
    companionsAllowed: datos.companionsAllowed,
  }
}

/**
 * Un error crudo de Prisma NO es un `DomainError`, así que el filtro global lo
 * sacaría como 500 genérico. La traducción se hace aquí, en la frontera: el
 * índice único parcial `(eventId, email)` llega como `P2002` —sin nombrar la
 * restricción, sólo con `meta.target`—, y se compara por CÓDIGO para que
 * renombrar el índice no rompa nada.
 */
function traducir(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new EmailDuplicadoError()
  }
  return error
}
