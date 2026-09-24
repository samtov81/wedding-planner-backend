import { Inject, Injectable } from '@nestjs/common'

import type { CursorPage, CursorValue } from '@/shared/domain'

import type { Expense } from '../domain/expense'
import { EXPENSE_REPOSITORY, type ExpenseRepository, type FiltroGastos } from './expense.repository'

@Injectable()
export class ListExpensesUseCase {
  constructor(@Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository) {}

  async ejecutar(
    eventId: string,
    filtro: FiltroGastos,
    cursor: CursorValue | null,
    limit: number,
  ): Promise<CursorPage<Expense>> {
    return await this.gastos.listar(eventId, filtro, cursor, limit)
  }
}
