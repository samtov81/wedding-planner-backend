import { Inject, Injectable } from '@nestjs/common'

import { paidAtTrasCambio } from '../domain/expense'
import type { Expense } from '../domain/expense'
import {
  GastoNoEncontradoError,
  ProveedorDelEventoNoEncontradoError,
} from '../domain/expense-errors'
import { type CambiosGasto, EXPENSE_REPOSITORY, type ExpenseRepository } from './expense.repository'

@Injectable()
export class UpdateExpenseUseCase {
  constructor(@Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository) {}

  async ejecutar(
    eventId: string,
    expenseId: string,
    cambios: Omit<CambiosGasto, 'paidAt'>,
  ): Promise<Expense> {
    const actual = await this.gastos.buscarPorId(eventId, expenseId)
    if (actual === null) throw new GastoNoEncontradoError()
    if (
      cambios.origen?.kind === 'vendor' &&
      !(await this.gastos.proveedorExiste(eventId, cambios.origen.eventVendorId))
    ) {
      throw new ProveedorDelEventoNoEncontradoError()
    }
    return await this.gastos.actualizar(eventId, expenseId, {
      ...cambios,
      paidAt: paidAtTrasCambio(actual, cambios.status, new Date()),
    })
  }
}
