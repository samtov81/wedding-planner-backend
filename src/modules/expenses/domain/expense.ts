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

export interface ResumenPresupuesto {
  currency: string
  totalBudget: string | null
  assigned: string
  unassigned: string | null
  paid: string
  pending: string
  remaining: string | null
}

export function calcularResumen(e: {
  currency: string
  totalBudget: string | null
  assigned: string
  paid: string
  pending: string
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
  }
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
