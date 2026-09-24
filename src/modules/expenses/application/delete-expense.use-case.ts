import { Inject, Injectable } from '@nestjs/common'

import { GastoNoEncontradoError } from '../domain/expense-errors'
import { EXPENSE_REPOSITORY, type ExpenseRepository } from './expense.repository'

@Injectable()
export class DeleteExpenseUseCase {
  constructor(@Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository) {}

  async ejecutar(eventId: string, expenseId: string): Promise<void> {
    if (!(await this.gastos.eliminar(eventId, expenseId))) throw new GastoNoEncontradoError()
  }
}
