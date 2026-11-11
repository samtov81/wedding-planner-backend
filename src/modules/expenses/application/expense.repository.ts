import type { CursorPage, CursorValue } from '@/shared/domain'

import type { ArchivoFactura, Expense, ExpenseStatus, SumaPorCategoria } from '../domain/expense'

export type { SumaPorCategoria }

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
  invoiceNumber: string | null
  subtotal: string | null
  invoiceFile: ArchivoFactura | null
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
  invoiceNumber?: string | null | undefined
  subtotal?: string | null | undefined
  invoiceFile?: ArchivoFactura | null | undefined
}

/**
 * `OVERDUE` no es un estado guardado: es PENDING con `dueDate < hoy` (spec
 * 2026-11-11), por eso el filtro lleva `hoy` (`YYYY-MM-DD` en la zona del evento).
 * `q` busca sin distinguir mayúsculas en concepto, beneficiario, número de
 * factura y nombre del proveedor.
 */
export interface FiltroGastos {
  status: ExpenseStatus | 'OVERDUE' | null
  origin: 'vendor' | 'external' | null
  eventVendorId: string | null
  q: string | null
  hoy: string
}

/** Un gasto PAID visto por el proveedor que lo cobró: sólo lo que le corresponde ver. */
export interface PagoRecibido {
  expenseId: string
  eventId: string
  eventName: string
  currency: string
  concept: string
  amount: string
  subtotal: string | null
  invoiceNumber: string | null
  paidAt: Date
  invoiceFile: ArchivoFactura | null
}

export interface SumasPresupuesto {
  assigned: string
  paid: string
  pending: string
}

export interface ExpenseRepository {
  proveedorExiste(eventId: string, eventVendorId: string): Promise<boolean>
  /** Lanza `NumeroDeFacturaRepetidoError` si el proveedor ya tiene ese número en el evento. */
  crear(datos: DatosNuevoGasto): Promise<Expense>
  buscarPorId(eventId: string, expenseId: string): Promise<Expense | null>
  /** `createdAt` desc, `id` desc. */
  listar(
    eventId: string,
    filtro: FiltroGastos,
    cursor: CursorValue | null,
    limit: number,
  ): Promise<CursorPage<Expense>>
  /**
   * Lanza `GastoNoEncontradoError` si no existe y `NumeroDeFacturaRepetidoError`
   * si el número ya lo usa el mismo proveedor en el evento.
   */
  actualizar(eventId: string, expenseId: string, cambios: CambiosGasto): Promise<Expense>
  eliminar(eventId: string, expenseId: string): Promise<boolean>
  sumas(eventId: string): Promise<SumasPresupuesto>
  /** Una fila por (categoría, estado) con su suma y número de gastos. */
  sumasPorCategoria(eventId: string): Promise<SumaPorCategoria[]>
  /** Suma y número de los PENDING con `dueDate < hoy`. */
  vencidos(eventId: string, hoy: string): Promise<{ amount: string; count: number }>
  /** PENDING con `dueDate >= hoy`: `dueDate` asc y `createdAt` asc de desempate. */
  proximos(eventId: string, hoy: string, limit: number): Promise<Expense[]>
  /** `null` si el `EventVendor` no tiene ficha (externo) o no existe. */
  proveedorCobrable(
    eventVendorId: string,
  ): Promise<{ userId: string; status: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED' } | null>
  /**
   * Gastos PAID de los `EventVendor` BOOKED o CANCELLED cuya ficha es de `userId`,
   * `paidAt` desc. `eventId` opcional restringe a un evento.
   */
  listarPagosRecibidos(userId: string, eventId: string | null): Promise<PagoRecibido[]>
  /** `null` fuera de la regla de `listarPagosRecibidos`. */
  buscarPagoRecibido(userId: string, expenseId: string): Promise<PagoRecibido | null>
}

export const EXPENSE_REPOSITORY = Symbol('EXPENSE_REPOSITORY')
