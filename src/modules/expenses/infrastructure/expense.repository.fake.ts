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
  SumasPresupuesto,
} from '../application/expense.repository'
import type { Expense, OrigenGasto } from '../domain/expense'
import { GastoNoEncontradoError } from '../domain/expense-errors'

export interface ProveedorEnMemoria {
  id: string
  eventId: string
  name: string
  assignedBudget: string | null
  status: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'
}

interface GastoEnMemoria extends Omit<Expense, 'origen'> {
  origen: OrigenEntrada
}

export class ExpenseRepositoryEnMemoria implements ExpenseRepository {
  readonly proveedores: ProveedorEnMemoria[] = []
  readonly gastos: GastoEnMemoria[] = []

  proveedorExiste(eventId: string, eventVendorId: string): Promise<boolean> {
    return Promise.resolve(
      this.proveedores.some((p) => p.id === eventVendorId && p.eventId === eventId),
    )
  }

  crear(datos: DatosNuevoGasto): Promise<Expense> {
    const ahora = new Date()
    const gasto: GastoEnMemoria = { ...datos, id: randomUUID(), createdAt: ahora, updatedAt: ahora }
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
      .filter((g) => filtro.status === null || g.status === filtro.status)
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
    for (const clave of Object.keys(cambios) as Array<keyof CambiosGasto>) {
      const valor = cambios[clave]
      if (valor !== undefined) Object.assign(gasto, { [clave]: valor })
    }
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
