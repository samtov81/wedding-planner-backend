import { aCentimos, deCentimos } from '@/shared/domain'

export type ExpenseStatus = 'PENDING' | 'PAID'

/** El origen de un gasto: proveedor contratado en el evento, o un tercero externo. */
export type OrigenGasto =
  | { kind: 'vendor'; eventVendorId: string; vendorName: string }
  | { kind: 'external'; payeeName: string }

export interface Expense {
  id: string
  eventId: string
  origen: OrigenGasto
  concept: string
  category: string
  amount: string
  status: ExpenseStatus
  dueDate: Date | null
  paidAt: Date | null
  notes: string | null
  createdById: string
  createdAt: Date
  updatedAt: Date
}

/** Suma de los gastos de una categoría y un estado (fila agrupada del repositorio). */
export interface SumaPorCategoria {
  category: string
  status: ExpenseStatus
  amount: string
  count: number
}

export interface ResumenPorCategoria {
  category: string
  paid: string
  pending: string
  total: string
  count: number
}

export interface ResumenPresupuesto {
  currency: string
  totalBudget: string | null
  assigned: string
  unassigned: string | null
  paid: string
  pending: string
  remaining: string | null
  byCategory: ResumenPorCategoria[]
}

export function calcularResumen(e: {
  currency: string
  totalBudget: string | null
  assigned: string
  paid: string
  pending: string
  porCategoria: SumaPorCategoria[]
}): ResumenPresupuesto {
  const total = e.totalBudget === null ? null : aCentimos(e.totalBudget)
  return {
    currency: e.currency,
    totalBudget: e.totalBudget,
    assigned: e.assigned,
    // Puede ser negativo: asignar más de lo presupuestado es un dato, no un error.
    unassigned: total === null ? null : deCentimos(total - aCentimos(e.assigned)),
    paid: e.paid,
    pending: e.pending,
    remaining: total === null ? null : deCentimos(total - aCentimos(e.paid) - aCentimos(e.pending)),
    byCategory: porCategoria(e.porCategoria),
  }
}

/** Pliega las filas (categoría, estado) en céntimos; orden: total desc, luego nombre. */
function porCategoria(filas: SumaPorCategoria[]): ResumenPorCategoria[] {
  const acc = new Map<string, { paid: bigint; pending: bigint; count: number }>()
  for (const f of filas) {
    const actual = acc.get(f.category) ?? { paid: 0n, pending: 0n, count: 0 }
    if (f.status === 'PAID') actual.paid += aCentimos(f.amount)
    else actual.pending += aCentimos(f.amount)
    actual.count += f.count
    acc.set(f.category, actual)
  }
  return [...acc.entries()]
    .map(([category, s]) => ({ category, s, total: s.paid + s.pending }))
    .sort((a, b) =>
      a.total === b.total ? a.category.localeCompare(b.category) : a.total > b.total ? -1 : 1,
    )
    .map(({ category, s, total }) => ({
      category,
      paid: deCentimos(s.paid),
      pending: deCentimos(s.pending),
      total: deCentimos(total),
      count: s.count,
    }))
}

/**
 * `paidAt` lo decide el servidor, nunca el cliente: se fija al pasar a PAID,
 * se conserva mientras siga PAID y se borra al volver a PENDING. Así el CHECK
 * `expenses_pagado_con_fecha` no puede romperse desde la API.
 */
export function paidAtTrasCambio(
  actual: { status: ExpenseStatus; paidAt: Date | null },
  nuevoEstado: ExpenseStatus | undefined,
  ahora: Date,
): Date | null {
  const estado = nuevoEstado ?? actual.status
  if (estado === 'PENDING') return null
  return actual.status === 'PAID' && actual.paidAt !== null ? actual.paidAt : ahora
}
