import { Injectable } from '@nestjs/common'
import type { SeatingTable as FilaMesa } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe } from '@/modules/database/transaccion'

import type {
  CambiosMesa,
  DatosNuevaMesa,
  SeatingRepository,
} from '../application/seating.repository'
import type { Asignacion, InvitadoSentable, Mesa, Ocupante } from '../domain/seating'
import { MesaNoEncontradaError } from '../domain/seating-errors'

/**
 * Todo va por `clienteDe(this.prisma)`, lecturas incluidas: los casos de uso
 * leen tras `bloquearEvento` dentro de la transacción y deben ver su propio
 * estado, no el de otra conexión.
 */
@Injectable()
export class PrismaSeatingRepository implements SeatingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async bloquearEvento(eventId: string): Promise<void> {
    // `$queryRaw` con template tag: el id va como parámetro, nada se concatena.
    await clienteDe(this.prisma).$queryRaw`
      SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE
    `
  }

  async listarMesas(eventId: string): Promise<Mesa[]> {
    const filas = await clienteDe(this.prisma).seatingTable.findMany({
      where: { eventId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return filas.map(aMesa)
  }

  async buscarMesa(eventId: string, tableId: string): Promise<Mesa | null> {
    const fila = await clienteDe(this.prisma).seatingTable.findFirst({
      where: { id: tableId, eventId },
    })
    return fila === null ? null : aMesa(fila)
  }

  async contarMesas(eventId: string): Promise<number> {
    return await clienteDe(this.prisma).seatingTable.count({ where: { eventId } })
  }

  async crearMesas(eventId: string, datos: DatosNuevaMesa[]): Promise<Mesa[]> {
    // `createdAt` explícito y estrictamente creciente, también respecto de la
    // última mesa: dos mesas en el mismo milisegundo empatarían y el orden
    // quedaría al azar del id. El caso de uso tiene el evento bloqueado.
    const cliente = clienteDe(this.prisma)
    const { _max } = await cliente.seatingTable.aggregate({
      where: { eventId },
      _max: { createdAt: true },
    })
    const base = Math.max(Date.now(), (_max.createdAt?.getTime() ?? 0) + 1)
    const creadas: Mesa[] = []
    for (const [i, d] of datos.entries()) {
      creadas.push(
        aMesa(
          await cliente.seatingTable.create({
            data: { ...d, eventId, createdAt: new Date(base + i) },
          }),
        ),
      )
    }
    return creadas
  }

  async actualizarMesa(eventId: string, tableId: string, cambios: CambiosMesa): Promise<Mesa> {
    const cliente = clienteDe(this.prisma)
    const { count } = await cliente.seatingTable.updateMany({
      where: { id: tableId, eventId },
      data: {
        ...(cambios.name !== undefined ? { name: cambios.name } : {}),
        ...(cambios.minSeats !== undefined ? { minSeats: cambios.minSeats } : {}),
        ...(cambios.maxSeats !== undefined ? { maxSeats: cambios.maxSeats } : {}),
        ...(cambios.seatCount !== undefined ? { seatCount: cambios.seatCount } : {}),
        ...(cambios.x !== undefined ? { x: cambios.x } : {}),
        ...(cambios.y !== undefined ? { y: cambios.y } : {}),
      },
    })
    if (count === 0) throw new MesaNoEncontradaError()
    const fila = await cliente.seatingTable.findFirst({ where: { id: tableId, eventId } })
    if (fila === null) throw new MesaNoEncontradaError()
    return aMesa(fila)
  }

  async eliminarMesa(eventId: string, tableId: string): Promise<boolean> {
    const { count } = await clienteDe(this.prisma).seatingTable.deleteMany({
      where: { id: tableId, eventId },
    })
    return count > 0
  }

  async listarAsignaciones(eventId: string): Promise<Asignacion[]> {
    return await clienteDe(this.prisma).seatAssignment.findMany({
      where: { eventId },
      select: { tableId: true, seatIndex: true, guestId: true, companionIndex: true },
    })
  }

  async asignar(eventId: string, a: Asignacion): Promise<void> {
    await clienteDe(this.prisma).seatAssignment.create({ data: { ...a, eventId } })
  }

  async quitarOcupantes(eventId: string, ocupantes: Ocupante[]): Promise<void> {
    if (ocupantes.length === 0) return
    await clienteDe(this.prisma).seatAssignment.deleteMany({
      where: {
        eventId,
        OR: ocupantes.map((o) => ({ guestId: o.guestId, companionIndex: o.companionIndex })),
      },
    })
  }

  async quitarAsiento(eventId: string, tableId: string, seatIndex: number): Promise<void> {
    await clienteDe(this.prisma).seatAssignment.deleteMany({
      where: { eventId, tableId, seatIndex },
    })
  }

  async buscarInvitado(eventId: string, guestId: string): Promise<InvitadoSentable | null> {
    return await clienteDe(this.prisma).guest.findFirst({
      where: { id: guestId, eventId },
      select: SENTABLE,
    })
  }

  async listarInvitados(eventId: string): Promise<InvitadoSentable[]> {
    return await clienteDe(this.prisma).guest.findMany({ where: { eventId }, select: SENTABLE })
  }
}

const SENTABLE = {
  id: true,
  rsvp: true,
  companionsAllowed: true,
  companionsConfirmed: true,
} as const

/** La fila de Prisma no sale de `infrastructure/`. */
function aMesa(fila: FilaMesa): Mesa {
  return {
    id: fila.id,
    eventId: fila.eventId,
    name: fila.name,
    minSeats: fila.minSeats,
    maxSeats: fila.maxSeats,
    seatCount: fila.seatCount,
    x: fila.x,
    y: fila.y,
    createdAt: fila.createdAt,
  }
}
