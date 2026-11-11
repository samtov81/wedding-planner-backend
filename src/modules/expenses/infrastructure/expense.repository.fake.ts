import { randomUUID } from 'node:crypto'

import {
  aCentimos,
  deCentimos,
  encodeCursor,
  type CursorPage,
  type CursorValue,
} from '@/shared/domain'

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
import { estaVencido, type Expense, type OrigenGasto } from '../domain/expense'
import { GastoNoEncontradoError, NumeroDeFacturaRepetidoError } from '../domain/expense-errors'

export interface ProveedorEnMemoria {
  id: string
  eventId: string
  name: string
  assignedBudget: string | null
  status: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'
  /** Dueño de la ficha del proveedor; `null` si es externo (sin ficha). */
  userId: string | null
}

export interface EventoEnMemoria {
  id: string
  name: string
  currency: string
}

interface GastoEnMemoria extends Omit<Expense, 'origen'> {
  origen: OrigenEntrada
}

export class ExpenseRepositoryEnMemoria implements ExpenseRepository {
  readonly proveedores: ProveedorEnMemoria[] = []
  readonly gastos: GastoEnMemoria[] = []
  readonly eventos: EventoEnMemoria[] = []

  /**
   * Réplica del índice `expenses_invoice_number_unique`: mismo evento, mismo
   * proveedor (`eventVendorId` o `payeeName` en minúsculas) y mismo número.
   */
  private numeroRepetido(candidato: GastoEnMemoria): boolean {
    if (candidato.invoiceNumber === null) return false
    const quien = (g: GastoEnMemoria) =>
      g.origen.kind === 'vendor' ? g.origen.eventVendorId : g.origen.payeeName.toLowerCase()
    return this.gastos.some(
      (g) =>
        g.id !== candidato.id &&
        g.eventId === candidato.eventId &&
        g.invoiceNumber === candidato.invoiceNumber &&
        quien(g) === quien(candidato),
    )
  }

  proveedorExiste(eventId: string, eventVendorId: string): Promise<boolean> {
    return Promise.resolve(
      this.proveedores.some((p) => p.id === eventVendorId && p.eventId === eventId),
    )
  }

  crear(datos: DatosNuevoGasto): Promise<Expense> {
    const ahora = new Date()
    const gasto: GastoEnMemoria = {
      ...datos,
      id: randomUUID(),
      createdAt: ahora,
      updatedAt: ahora,
    }
    if (this.numeroRepetido(gasto)) return Promise.reject(new NumeroDeFacturaRepetidoError())
    this.gastos.push(gasto)
    return Promise.resolve(this.aDominio(gasto))
  }

  buscarPorId(eventId: string, expenseId: string): Promise<Expense | null> {
    const gasto = this.gastos.find((g) => g.id === expenseId && g.eventId === eventId)
    return Promise.resolve(gasto === undefined ? null : this.aDominio(gasto))
  }

  listar(
    eventId: string,
    filtro: FiltroGastos,
    cursor: CursorValue | null,
    limit: number,
  ): Promise<CursorPage<Expense>> {
    const candidatos = this.gastos
      .filter((g) => g.eventId === eventId)
      .filter(
        (g) =>
          filtro.status === null ||
          (filtro.status === 'OVERDUE' ? estaVencido(g, filtro.hoy) : g.status === filtro.status),
      )
      .filter((g) => filtro.q === null || this.coincideConBusqueda(g, filtro.q))
      .filter((g) => filtro.origin === null || g.origen.kind === filtro.origin)
      .filter(
        (g) =>
          filtro.eventVendorId === null ||
          (g.origen.kind === 'vendor' && g.origen.eventVendorId === filtro.eventVendorId),
      )
      .filter(
        (g) =>
          cursor === null ||
          g.createdAt.getTime() < cursor.createdAt.getTime() ||
          (g.createdAt.getTime() === cursor.createdAt.getTime() && g.id < cursor.id),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
    const items = candidatos.slice(0, limit)
    const ultimo = items.at(-1)
    return Promise.resolve({
      items: items.map((g) => this.aDominio(g)),
      nextCursor:
        candidatos.length > limit && ultimo !== undefined
          ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id })
          : null,
    })
  }

  actualizar(eventId: string, expenseId: string, cambios: CambiosGasto): Promise<Expense> {
    const gasto = this.gastos.find((g) => g.id === expenseId && g.eventId === eventId)
    if (gasto === undefined) return Promise.reject(new GastoNoEncontradoError())
    const propuesto: GastoEnMemoria = {
      ...gasto,
      ...Object.fromEntries(Object.entries(cambios).filter(([, valor]) => valor !== undefined)),
    }
    if (this.numeroRepetido(propuesto)) return Promise.reject(new NumeroDeFacturaRepetidoError())
    Object.assign(gasto, propuesto)
    gasto.updatedAt = new Date()
    return Promise.resolve(this.aDominio(gasto))
  }

  eliminar(eventId: string, expenseId: string): Promise<boolean> {
    const i = this.gastos.findIndex((g) => g.id === expenseId && g.eventId === eventId)
    if (i === -1) return Promise.resolve(false)
    this.gastos.splice(i, 1)
    return Promise.resolve(true)
  }

  sumas(eventId: string): Promise<SumasPresupuesto> {
    const suma = (montos: string[]) => deCentimos(montos.reduce((t, m) => t + aCentimos(m), 0n))
    const delEvento = this.gastos.filter((g) => g.eventId === eventId)
    return Promise.resolve({
      assigned: suma(
        this.proveedores
          .filter(
            (p) => p.eventId === eventId && p.status !== 'CANCELLED' && p.assignedBudget !== null,
          )
          .map((p) => p.assignedBudget ?? '0'),
      ),
      paid: suma(delEvento.filter((g) => g.status === 'PAID').map((g) => g.amount)),
      pending: suma(delEvento.filter((g) => g.status === 'PENDING').map((g) => g.amount)),
    })
  }

  sumasPorCategoria(eventId: string): Promise<SumaPorCategoria[]> {
    const acc = new Map<string, SumaPorCategoria>()
    for (const g of this.gastos.filter((x) => x.eventId === eventId)) {
      const clave = `${g.category}\u0000${g.status}`
      const actual = acc.get(clave) ?? {
        category: g.category,
        status: g.status,
        amount: '0.00',
        count: 0,
      }
      acc.set(clave, {
        ...actual,
        amount: deCentimos(aCentimos(actual.amount) + aCentimos(g.amount)),
        count: actual.count + 1,
      })
    }
    return Promise.resolve([...acc.values()])
  }

  vencidos(eventId: string, hoy: string): Promise<{ amount: string; count: number }> {
    const lista = this.gastos.filter((g) => g.eventId === eventId && estaVencido(g, hoy))
    return Promise.resolve({
      amount: deCentimos(lista.reduce((t, g) => t + aCentimos(g.amount), 0n)),
      count: lista.length,
    })
  }

  proximos(eventId: string, hoy: string, limit: number): Promise<Expense[]> {
    return Promise.resolve(
      this.gastos
        .filter(
          (g) =>
            g.eventId === eventId &&
            g.status === 'PENDING' &&
            g.dueDate !== null &&
            g.dueDate.toISOString().slice(0, 10) >= hoy,
        )
        .sort(
          (a, b) =>
            (a.dueDate?.getTime() ?? 0) - (b.dueDate?.getTime() ?? 0) ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (a.id < b.id ? -1 : 1),
        )
        .slice(0, limit)
        .map((g) => this.aDominio(g)),
    )
  }

  proveedorCobrable(
    eventVendorId: string,
  ): Promise<{ userId: string; status: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED' } | null> {
    const p = this.proveedores.find((x) => x.id === eventVendorId)
    return Promise.resolve(
      p === undefined || p.userId === null ? null : { userId: p.userId, status: p.status },
    )
  }

  listarPagosRecibidos(userId: string, eventId: string | null): Promise<PagoRecibido[]> {
    return Promise.resolve(
      this.gastos
        .filter((g) => eventId === null || g.eventId === eventId)
        .map((g) => this.comoPago(userId, g))
        .filter((p): p is PagoRecibido => p !== null)
        .sort(
          (a, b) => b.paidAt.getTime() - a.paidAt.getTime() || (a.expenseId < b.expenseId ? 1 : -1),
        ),
    )
  }

  buscarPagoRecibido(userId: string, expenseId: string): Promise<PagoRecibido | null> {
    const g = this.gastos.find((x) => x.id === expenseId)
    return Promise.resolve(g === undefined ? null : this.comoPago(userId, g))
  }

  /** `null` si el gasto no es un PAID de un proveedor BOOKED/CANCELLED de `userId`. */
  private comoPago(userId: string, g: GastoEnMemoria): PagoRecibido | null {
    if (g.status !== 'PAID' || g.paidAt === null || g.origen.kind !== 'vendor') return null
    const { eventVendorId } = g.origen
    const p = this.proveedores.find((x) => x.id === eventVendorId)
    if (p === undefined || p.userId !== userId || p.status === 'SHORTLISTED') return null
    const evento = this.eventos.find((e) => e.id === g.eventId)
    if (evento === undefined) return null
    return {
      expenseId: g.id,
      eventId: g.eventId,
      eventName: evento.name,
      currency: evento.currency,
      concept: g.concept,
      amount: g.amount,
      subtotal: g.subtotal,
      invoiceNumber: g.invoiceNumber,
      paidAt: g.paidAt,
      invoiceFile: g.invoiceFile,
    }
  }

  private coincideConBusqueda(g: GastoEnMemoria, q: string): boolean {
    const aguja = q.toLowerCase()
    const nombre =
      g.origen.kind === 'vendor'
        ? this.proveedores.find(
            (p) => g.origen.kind === 'vendor' && p.id === g.origen.eventVendorId,
          )?.name
        : g.origen.payeeName
    return [g.concept, nombre, g.invoiceNumber].some(
      (campo) => campo !== null && campo !== undefined && campo.toLowerCase().includes(aguja),
    )
  }

  private aDominio(gasto: GastoEnMemoria): Expense {
    let origen: OrigenGasto
    if (gasto.origen.kind === 'vendor') {
      // TypeScript no estrecha `gasto.origen` dentro del callback de `find`: se
      // captura `eventVendorId` antes para que el retorno del arrow siga
      // siendo `string` y no `string | undefined`.
      const { eventVendorId } = gasto.origen
      origen = {
        kind: 'vendor',
        eventVendorId,
        vendorName: this.proveedores.find((p) => p.id === eventVendorId)?.name ?? '',
      }
    } else {
      origen = gasto.origen
    }
    return { ...gasto, origen }
  }
}
