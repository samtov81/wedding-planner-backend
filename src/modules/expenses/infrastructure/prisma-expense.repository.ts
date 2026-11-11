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
  PagoRecibido,
  SumaPorCategoria,
  SumasPresupuesto,
} from '../application/expense.repository'
import type { ArchivoFactura, Expense } from '../domain/expense'
import { GastoNoEncontradoError, NumeroDeFacturaRepetidoError } from '../domain/expense-errors'

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

/** Columnas de factura a escribir: `undefined` no toca nada, `null` las vacía las cuatro. */
function columnasArchivo(archivo: ArchivoFactura | null | undefined): {
  invoiceFileKey?: string | null
  invoiceFileName?: string | null
  invoiceFileType?: string | null
  invoiceFileBytes?: number | null
} {
  if (archivo === undefined) return {}
  // Las cuatro a la vez: el CHECK `expenses_archivo_completo` rechaza un archivo a medias.
  return archivo === null
    ? { invoiceFileKey: null, invoiceFileName: null, invoiceFileType: null, invoiceFileBytes: null }
    : {
        invoiceFileKey: archivo.key,
        invoiceFileName: archivo.name,
        invoiceFileType: archivo.contentType,
        invoiceFileBytes: archivo.bytes,
      }
}

/**
 * Prisma informa del índice único por EXPRESIÓN `expenses_invoice_number_unique`
 * como `P2002` sin nombre de índice: `meta.target` trae la lista de columnas, que
 * incluye `COALESCE(...)` (sólo este índice de `expenses` la tiene). Cualquier otro
 * `P2002` se deja propagar.
 */
function esNumeroRepetido(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }
  const target = error.meta?.['target']
  const texto = Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : ''
  return texto.includes('COALESCE') || texto.includes('invoiceNumber')
}

function aFecha(hoy: string): Date {
  return new Date(`${hoy}T00:00:00.000Z`)
}

type FilaPago = Prisma.ExpenseGetPayload<{
  include: { event: { select: { name: true; currency: true } } }
}>

function aPago(fila: FilaPago): PagoRecibido {
  return {
    expenseId: fila.id,
    eventId: fila.eventId,
    eventName: fila.event.name,
    currency: fila.event.currency,
    concept: fila.concept,
    amount: fila.amount.toFixed(2),
    subtotal: fila.subtotal === null ? null : fila.subtotal.toFixed(2),
    invoiceNumber: fila.invoiceNumber,
    // El CHECK `expenses_pagado_con_fecha` garantiza `paidAt` en un PAID.
    paidAt: fila.paidAt ?? fila.createdAt,
    invoiceFile: archivoDe(fila),
  }
}

function archivoDe(fila: {
  invoiceFileKey: string | null
  invoiceFileName: string | null
  invoiceFileType: string | null
  invoiceFileBytes: number | null
}): ArchivoFactura | null {
  if (
    fila.invoiceFileKey === null ||
    fila.invoiceFileName === null ||
    fila.invoiceFileType === null ||
    fila.invoiceFileBytes === null
  ) {
    return null
  }
  return {
    key: fila.invoiceFileKey,
    name: fila.invoiceFileName,
    contentType: fila.invoiceFileType,
    bytes: fila.invoiceFileBytes,
  }
}

/** Gasto PAID de un EventVendor BOOKED/CANCELLED cuya ficha pertenece a `userId`. */
function cobradoPor(userId: string): Prisma.ExpenseWhereInput {
  return {
    status: 'PAID',
    eventVendor: {
      status: { in: ['BOOKED', 'CANCELLED'] },
      vendorProfile: { userId },
    },
  }
}

@Injectable()
export class PrismaExpenseRepository implements ExpenseRepository {
  constructor(private readonly prisma: PrismaService) {}

  async proveedorExiste(eventId: string, eventVendorId: string): Promise<boolean> {
    return (await this.prisma.eventVendor.count({ where: { id: eventVendorId, eventId } })) > 0
  }

  async crear(datos: DatosNuevoGasto): Promise<Expense> {
    try {
      return await this.insertar(datos)
    } catch (e) {
      if (esNumeroRepetido(e)) throw new NumeroDeFacturaRepetidoError()
      throw e
    }
  }

  private async insertar(datos: DatosNuevoGasto): Promise<Expense> {
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
        invoiceNumber: datos.invoiceNumber,
        subtotal: datos.subtotal,
        ...columnasArchivo(datos.invoiceFile),
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
        ...(filtro.status === 'OVERDUE'
          ? { status: 'PENDING' as const, dueDate: { lt: aFecha(filtro.hoy) } }
          : filtro.status !== null
            ? { status: filtro.status }
            : {}),
        // `origin` y `eventVendorId` son dos condiciones INDEPENDIENTES sobre
        // la misma columna: si fueran dos claves sueltas del `where`, la
        // segunda machacaría a la primera en vez de combinarse (JS no permite
        // dos claves `eventVendorId` en el mismo objeto). Un `AND` con una
        // entrada por condición las combina de verdad, igual que hace
        // `ExpenseRepositoryEnMemoria.listar`.
        AND: [
          // `q` y el cursor son cada uno un `OR`: van en el `AND` para no pisarse.
          ...(filtro.q !== null
            ? [
                {
                  OR: [
                    { concept: { contains: filtro.q, mode: 'insensitive' as const } },
                    { payeeName: { contains: filtro.q, mode: 'insensitive' as const } },
                    { invoiceNumber: { contains: filtro.q, mode: 'insensitive' as const } },
                    {
                      eventVendor: {
                        externalName: { contains: filtro.q, mode: 'insensitive' as const },
                      },
                    },
                    {
                      eventVendor: {
                        vendorProfile: {
                          businessName: { contains: filtro.q, mode: 'insensitive' as const },
                        },
                      },
                    },
                  ],
                },
              ]
            : []),
          ...(filtro.origin === 'vendor' ? [{ eventVendorId: { not: null } }] : []),
          ...(filtro.origin === 'external' ? [{ eventVendorId: null }] : []),
          ...(filtro.eventVendorId !== null ? [{ eventVendorId: filtro.eventVendorId }] : []),
          ...(cursor !== null
            ? [
                {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                },
              ]
            : []),
        ],
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
    let count: number
    try {
      ;({ count } = await cliente.expense.updateMany({
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
          ...(cambios.invoiceNumber !== undefined ? { invoiceNumber: cambios.invoiceNumber } : {}),
          ...(cambios.subtotal !== undefined ? { subtotal: cambios.subtotal } : {}),
          ...columnasArchivo(cambios.invoiceFile),
        },
      }))
    } catch (e) {
      if (esNumeroRepetido(e)) throw new NumeroDeFacturaRepetidoError()
      throw e
    }
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

  async sumasPorCategoria(eventId: string): Promise<SumaPorCategoria[]> {
    const grupos = await this.prisma.expense.groupBy({
      by: ['category', 'status'],
      where: { eventId },
      _sum: { amount: true },
      _count: { _all: true },
    })
    return grupos.map((g) => ({
      category: g.category,
      status: g.status,
      amount: (g._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
      count: g._count._all,
    }))
  }

  async vencidos(eventId: string, hoy: string): Promise<{ amount: string; count: number }> {
    const r = await this.prisma.expense.aggregate({
      where: { eventId, status: 'PENDING', dueDate: { lt: aFecha(hoy) } },
      _sum: { amount: true },
      _count: { _all: true },
    })
    return { amount: (r._sum.amount ?? new Prisma.Decimal(0)).toFixed(2), count: r._count._all }
  }

  async proximos(eventId: string, hoy: string, limit: number): Promise<Expense[]> {
    const filas = await this.prisma.expense.findMany({
      where: { eventId, status: 'PENDING', dueDate: { gte: aFecha(hoy) } },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      include: CON_PROVEEDOR,
    })
    return filas.map(aDominio)
  }

  async proveedorCobrable(
    eventVendorId: string,
  ): Promise<{ userId: string; status: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED' } | null> {
    const fila = await this.prisma.eventVendor.findUnique({
      where: { id: eventVendorId },
      select: { status: true, vendorProfile: { select: { userId: true } } },
    })
    if (fila === null || fila.vendorProfile === null) return null
    return { userId: fila.vendorProfile.userId, status: fila.status }
  }

  async listarPagosRecibidos(userId: string, eventId: string | null): Promise<PagoRecibido[]> {
    const filas = await this.prisma.expense.findMany({
      where: { ...cobradoPor(userId), ...(eventId !== null ? { eventId } : {}) },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      include: { event: { select: { name: true, currency: true } } },
    })
    return filas.map(aPago)
  }

  async buscarPagoRecibido(userId: string, expenseId: string): Promise<PagoRecibido | null> {
    const fila = await this.prisma.expense.findFirst({
      where: { id: expenseId, ...cobradoPor(userId) },
      include: { event: { select: { name: true, currency: true } } },
    })
    return fila === null ? null : aPago(fila)
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
    invoiceNumber: fila.invoiceNumber,
    subtotal: fila.subtotal === null ? null : fila.subtotal.toFixed(2),
    invoiceFile: archivoDe(fila),
    createdById: fila.createdById,
    createdAt: fila.createdAt,
    updatedAt: fila.updatedAt,
  }
}
