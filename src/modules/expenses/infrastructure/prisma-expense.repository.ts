import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe } from '@/modules/database/transaccion'
import { encodeCursor, type CursorPage, type CursorValue } from '@/shared/domain'

import type {
  CambiosGasto,
  DatosNuevoGasto,
  ExpenseRepository,
  FiltroGastos,
  OrigenEntrada,
  SumasPresupuesto,
} from '../application/expense.repository'
import type { Expense } from '../domain/expense'
import { GastoNoEncontradoError } from '../domain/expense-errors'

const CON_PROVEEDOR = {
  eventVendor: {
    select: { externalName: true, vendorProfile: { select: { businessName: true } } },
  },
} satisfies Prisma.ExpenseInclude

type Fila = Prisma.ExpenseGetPayload<{ include: typeof CON_PROVEEDOR }>

function columnasOrigen(origen: OrigenEntrada | undefined): {
  eventVendorId?: string | null
  payeeName?: string | null
} {
  if (origen === undefined) return {}
  // Se escriben las DOS columnas siempre: cambiar de origen tiene que vaciar
  // la otra, o el CHECK `expenses_origen_exclusivo` rechaza la fila.
  return origen.kind === 'vendor'
    ? { eventVendorId: origen.eventVendorId, payeeName: null }
    : { eventVendorId: null, payeeName: origen.payeeName }
}

@Injectable()
export class PrismaExpenseRepository implements ExpenseRepository {
  constructor(private readonly prisma: PrismaService) {}

  async proveedorExiste(eventId: string, eventVendorId: string): Promise<boolean> {
    return (await this.prisma.eventVendor.count({ where: { id: eventVendorId, eventId } })) > 0
  }

  async crear(datos: DatosNuevoGasto): Promise<Expense> {
    const fila = await clienteDe(this.prisma).expense.create({
      data: {
        eventId: datos.eventId,
        ...columnasOrigen(datos.origen),
        concept: datos.concept,
        category: datos.category,
        amount: datos.amount,
        status: datos.status,
        paidAt: datos.paidAt,
        dueDate: datos.dueDate,
        notes: datos.notes,
        createdById: datos.createdById,
      },
      include: CON_PROVEEDOR,
    })
    return aDominio(fila)
  }

  async buscarPorId(eventId: string, expenseId: string): Promise<Expense | null> {
    const fila = await this.prisma.expense.findFirst({
      where: { id: expenseId, eventId },
      include: CON_PROVEEDOR,
    })
    return fila === null ? null : aDominio(fila)
  }

  async listar(
    eventId: string,
    filtro: FiltroGastos,
    cursor: CursorValue | null,
    limit: number,
  ): Promise<CursorPage<Expense>> {
    const filas = await this.prisma.expense.findMany({
      where: {
        eventId,
        ...(filtro.status !== null ? { status: filtro.status } : {}),
        ...(filtro.origin === 'vendor' ? { eventVendorId: { not: null } } : {}),
        ...(filtro.origin === 'external' ? { eventVendorId: null } : {}),
        ...(filtro.eventVendorId !== null ? { eventVendorId: filtro.eventVendorId } : {}),
        ...(cursor !== null
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: CON_PROVEEDOR,
    })
    const items = filas.slice(0, limit)
    const ultimo = items.at(-1)
    return {
      items: items.map(aDominio),
      nextCursor:
        filas.length > limit && ultimo !== undefined
          ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id })
          : null,
    }
  }

  async actualizar(eventId: string, expenseId: string, cambios: CambiosGasto): Promise<Expense> {
    const cliente = clienteDe(this.prisma)
    const { count } = await cliente.expense.updateMany({
      where: { id: expenseId, eventId },
      data: {
        ...columnasOrigen(cambios.origen),
        ...(cambios.concept !== undefined ? { concept: cambios.concept } : {}),
        ...(cambios.category !== undefined ? { category: cambios.category } : {}),
        ...(cambios.amount !== undefined ? { amount: cambios.amount } : {}),
        ...(cambios.status !== undefined ? { status: cambios.status } : {}),
        ...(cambios.paidAt !== undefined ? { paidAt: cambios.paidAt } : {}),
        ...(cambios.dueDate !== undefined ? { dueDate: cambios.dueDate } : {}),
        ...(cambios.notes !== undefined ? { notes: cambios.notes } : {}),
      },
    })
    if (count === 0) throw new GastoNoEncontradoError()
    const fila = await cliente.expense.findFirst({
      where: { id: expenseId, eventId },
      include: CON_PROVEEDOR,
    })
    if (fila === null) throw new GastoNoEncontradoError()
    return aDominio(fila)
  }

  async eliminar(eventId: string, expenseId: string): Promise<boolean> {
    const { count } = await clienteDe(this.prisma).expense.deleteMany({
      where: { id: expenseId, eventId },
    })
    return count > 0
  }

  async sumas(eventId: string): Promise<SumasPresupuesto> {
    const [asignado, porEstado] = await Promise.all([
      this.prisma.eventVendor.aggregate({
        where: { eventId, status: { not: 'CANCELLED' } },
        _sum: { assignedBudget: true },
      }),
      this.prisma.expense.groupBy({ by: ['status'], where: { eventId }, _sum: { amount: true } }),
    ])
    const de = (status: 'PAID' | 'PENDING') =>
      (porEstado.find((g) => g.status === status)?._sum.amount ?? new Prisma.Decimal(0)).toFixed(2)
    return {
      assigned: (asignado._sum.assignedBudget ?? new Prisma.Decimal(0)).toFixed(2),
      paid: de('PAID'),
      pending: de('PENDING'),
    }
  }
}

function aDominio(fila: Fila): Expense {
  return {
    id: fila.id,
    eventId: fila.eventId,
    origen:
      fila.eventVendorId !== null
        ? {
            kind: 'vendor',
            eventVendorId: fila.eventVendorId,
            vendorName:
              fila.eventVendor?.vendorProfile?.businessName ?? fila.eventVendor?.externalName ?? '',
          }
        : { kind: 'external', payeeName: fila.payeeName ?? '' },
    concept: fila.concept,
    category: fila.category,
    amount: fila.amount.toFixed(2),
    status: fila.status,
    dueDate: fila.dueDate,
    paidAt: fila.paidAt,
    notes: fila.notes,
    createdById: fila.createdById,
    createdAt: fila.createdAt,
    updatedAt: fila.updatedAt,
  }
}
