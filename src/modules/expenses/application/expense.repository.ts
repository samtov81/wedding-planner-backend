import type { CursorPage, CursorValue } from '@/shared/domain'

import type { Expense, ExpenseStatus } from '../domain/expense'

export type OrigenEntrada =
  { kind: 'vendor'; eventVendorId: string } | { kind: 'external'; payeeName: string }

export interface DatosNuevoGasto {
  eventId: string
  origen: OrigenEntrada
  concept: string
  category: string
  amount: string
  status: ExpenseStatus
  paidAt: Date | null
  dueDate: Date | null
  notes: string | null
  createdById: string
}

export interface CambiosGasto {
  origen?: OrigenEntrada | undefined
  concept?: string | undefined
  category?: string | undefined
  amount?: string | undefined
  status?: ExpenseStatus | undefined
  paidAt?: Date | null | undefined
  dueDate?: Date | null | undefined
  notes?: string | null | undefined
}

export interface FiltroGastos {
  status: ExpenseStatus | null
  origin: 'vendor' | 'external' | null
  eventVendorId: string | null
}

export interface SumasPresupuesto {
  assigned: string
  paid: string
  pending: string
}

export interface ExpenseRepository {
  proveedorExiste(eventId: string, eventVendorId: string): Promise<boolean>
  crear(datos: DatosNuevoGasto): Promise<Expense>
  buscarPorId(eventId: string, expenseId: string): Promise<Expense | null>
  /** `createdAt` desc, `id` desc. */
  listar(
    eventId: string,
    filtro: FiltroGastos,
    cursor: CursorValue | null,
    limit: number,
  ): Promise<CursorPage<Expense>>
  /** Lanza `GastoNoEncontradoError` si no existe. */
  actualizar(eventId: string, expenseId: string, cambios: CambiosGasto): Promise<Expense>
  eliminar(eventId: string, expenseId: string): Promise<boolean>
  sumas(eventId: string): Promise<SumasPresupuesto>
}

export const EXPENSE_REPOSITORY = Symbol('EXPENSE_REPOSITORY')
