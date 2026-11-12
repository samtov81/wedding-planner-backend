import { Inject, Injectable } from '@nestjs/common'

import { SubidaDeFacturas } from '@/modules/storage/application/subida-de-facturas'
import { AlmacenamientoNoDisponibleError } from '@/modules/storage/domain/imagen'
import { aCentimos, deCentimos } from '@/shared/domain'

import {
  ArchivoDeFacturaNoEncontradoError,
  PagoRecibidoNoEncontradoError,
} from '../domain/expense-errors'
import { EXPENSE_REPOSITORY, type ExpenseRepository, type PagoRecibido } from './expense.repository'

/** Los pagos que un proveedor ha cobrado en un evento, con su total. */
export interface PagosDeEvento {
  eventId: string
  eventName: string
  currency: string
  totalReceived: string
  payments: PagoRecibido[]
}

/**
 * Lo que ve un proveedor de sus cobros (spec 2026-11-11 §5 y §8). La regla de
 * quién cuenta como "proveedor cobrado" vive en el puerto: aquí sólo se agrupa.
 *
 * Orden: el repositorio entrega `paidAt` desc; los eventos salen por su pago más
 * reciente (el primero que aparece) y dentro de cada uno se conserva ese orden.
 * Alternativa descartada: ordenar los eventos por nombre, que esconde en la
 * parte baja el evento donde acaban de pagarle.
 */
@Injectable()
export class PagosRecibidosUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository,
    private readonly subidas: SubidaDeFacturas,
  ) {}

  async listar(userId: string, eventId: string | null): Promise<PagosDeEvento[]> {
    const pagos = await this.gastos.listarPagosRecibidos(userId, eventId)
    const porEvento = new Map<string, PagosDeEvento & { centimos: bigint }>()
    for (const pago of pagos) {
      let grupo = porEvento.get(pago.eventId)
      if (grupo === undefined) {
        grupo = {
          eventId: pago.eventId,
          eventName: pago.eventName,
          currency: pago.currency,
          totalReceived: '0.00',
          payments: [],
          centimos: 0n,
        }
        porEvento.set(pago.eventId, grupo)
      }
      grupo.payments.push(pago)
      grupo.centimos += aCentimos(pago.amount)
    }
    return [...porEvento.values()].map(({ centimos, ...grupo }) => ({
      ...grupo,
      totalReceived: deCentimos(centimos),
    }))
  }

  /**
   * URL prefirmada del archivo de un pago propio. Un pago ajeno o fuera de la
   * regla es 404 `VENDOR_PAYMENT_NOT_FOUND` (no se revela que existe); uno
   * propio sin archivo, 404 `INVOICE_FILE_NOT_FOUND`; sin R2, 503.
   */
  async archivo(userId: string, expenseId: string): Promise<{ url: string }> {
    const pago = await this.gastos.buscarPagoRecibido(userId, expenseId)
    if (pago === null) throw new PagoRecibidoNoEncontradoError()
    if (pago.invoiceFile === null) throw new ArchivoDeFacturaNoEncontradoError()
    const url = await this.subidas.firmarLectura(pago.invoiceFile.key, pago.invoiceFile.name)
    if (url === null) throw new AlmacenamientoNoDisponibleError()
    return { url }
  }
}
