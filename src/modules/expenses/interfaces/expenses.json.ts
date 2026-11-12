import type { PagosDeEvento } from '../application/pagos-recibidos.use-cases'
import type { PagoRecibido } from '../application/expense.repository'
import { type ArchivoFactura, type GastoListado, impuestoDe } from '../domain/expense'

/** Lo que el cliente ve del archivo: nunca la `key` de R2, que se canjea por `{ url }`. */
export interface ArchivoJson {
  name: string
  contentType: string
  bytes: number
}

export interface GastoJson {
  id: string
  origin:
    | { kind: 'vendor'; eventVendorId: string; vendorName: string }
    | { kind: 'external'; payeeName: string }
  concept: string
  category: string
  amount: string
  status: 'PENDING' | 'PAID'
  dueDate: string | null
  paidAt: string | null
  notes: string | null
  createdAt: string
  invoiceNumber: string | null
  subtotal: string | null
  tax: string | null
  invoiceFile: ArchivoJson | null
  overdue: boolean
}

/** Lo que cobra un proveedor: sin `notes`, `category` ni `dueDate` (spec 2026-11-11 §5). */
export interface PagoJson {
  id: string
  concept: string
  amount: string
  subtotal: string | null
  tax: string | null
  invoiceNumber: string | null
  paidAt: string
  invoiceFile: ArchivoJson | null
}

export interface PagosDeEventoJson {
  eventId: string
  eventName: string
  currency: string
  totalReceived: string
  payments: PagoJson[]
}

export function aArchivoJson(a: ArchivoFactura | null): ArchivoJson | null {
  return a === null ? null : { name: a.name, contentType: a.contentType, bytes: a.bytes }
}

export function aGastoJson(g: GastoListado): GastoJson {
  return {
    id: g.id,
    origin: g.origen,
    concept: g.concept,
    category: g.category,
    amount: g.amount,
    status: g.status,
    dueDate: g.dueDate?.toISOString().slice(0, 10) ?? null,
    paidAt: g.paidAt?.toISOString() ?? null,
    notes: g.notes,
    createdAt: g.createdAt.toISOString(),
    invoiceNumber: g.invoiceNumber,
    subtotal: g.subtotal,
    tax: impuestoDe(g.amount, g.subtotal),
    invoiceFile: aArchivoJson(g.invoiceFile),
    overdue: g.overdue,
  }
}

/** Campo a campo y explícito: un campo nuevo en `PagoRecibido` no llega al proveedor sin querer. */
export function aPagoJson(p: PagoRecibido): PagoJson {
  return {
    id: p.expenseId,
    concept: p.concept,
    amount: p.amount,
    subtotal: p.subtotal,
    tax: impuestoDe(p.amount, p.subtotal),
    invoiceNumber: p.invoiceNumber,
    paidAt: p.paidAt.toISOString(),
    invoiceFile: aArchivoJson(p.invoiceFile),
  }
}

export function aPagosDeEventoJson(e: PagosDeEvento): PagosDeEventoJson {
  return {
    eventId: e.eventId,
    eventName: e.eventName,
    currency: e.currency,
    totalReceived: e.totalReceived,
    payments: e.payments.map(aPagoJson),
  }
}
