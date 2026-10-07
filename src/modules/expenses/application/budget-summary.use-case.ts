import { Inject, Injectable } from '@nestjs/common'

import {
  EVENT_REPOSITORY,
  type EventRepository,
} from '@/modules/events/application/event.repository'
import { NotFoundError } from '@/shared/domain'

import { calcularResumen, type ResumenPresupuesto } from '../domain/expense'
import { EXPENSE_REPOSITORY, type ExpenseRepository } from './expense.repository'

@Injectable()
export class BudgetSummaryUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository,
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
  ) {}

  async ejecutar(eventId: string): Promise<ResumenPresupuesto> {
    const evento = await this.eventos.buscarPorId(eventId)
    // Solo lo alcanza un ADMIN sobre un id inexistente: el guard ya dio 404 al resto.
    if (evento === null) throw new NotFoundError('El evento no existe')
    const [sumas, porCategoria] = await Promise.all([
      this.gastos.sumas(eventId),
      this.gastos.sumasPorCategoria(eventId),
    ])
    return calcularResumen({
      currency: evento.currency,
      totalBudget: evento.totalBudget,
      ...sumas,
      porCategoria,
    })
  }
}
