import { Inject, Injectable } from '@nestjs/common'

import type { Expense, ExpenseStatus } from '../domain/expense'
import { ProveedorDelEventoNoEncontradoError } from '../domain/expense-errors'
import {
  type DatosNuevoGasto,
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
} from './expense.repository'

export type EntradaGasto = Omit<
  DatosNuevoGasto,
  'eventId' | 'createdById' | 'paidAt' | 'status'
> & {
  status?: ExpenseStatus | undefined
}

@Injectable()
export class CreateExpenseUseCase {
  constructor(@Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository) {}

  async ejecutar(eventId: string, entrada: EntradaGasto, actorId: string): Promise<Expense> {
    if (
      entrada.origen.kind === 'vendor' &&
      !(await this.gastos.proveedorExiste(eventId, entrada.origen.eventVendorId))
    ) {
      throw new ProveedorDelEventoNoEncontradoError()
    }
    const status = entrada.status ?? 'PENDING'
    return await this.gastos.crear({
      ...entrada,
      eventId,
      status,
      paidAt: status === 'PAID' ? new Date() : null,
      createdById: actorId,
    })
  }
}
