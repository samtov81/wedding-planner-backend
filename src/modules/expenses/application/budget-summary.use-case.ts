import { Inject, Injectable, Optional } from '@nestjs/common'

import {
  EVENT_REPOSITORY,
  type EventRepository,
} from '@/modules/events/application/event.repository'
import { NotFoundError } from '@/shared/domain'

import { calcularResumen, estaVencido, hoyEnZona, type ResumenPresupuesto } from '../domain/expense'
import { EXPENSE_REPOSITORY, type ExpenseRepository } from './expense.repository'
import { RELOJ_GASTOS, type Reloj } from './reloj'

/** Cuántos próximos pagos lleva el resumen (spec 2026-11-11 §6). */
const PROXIMOS = 5

@Injectable()
export class BudgetSummaryUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository,
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
    @Optional() @Inject(RELOJ_GASTOS) private readonly ahora: Reloj = () => new Date(),
  ) {}

  async ejecutar(eventId: string): Promise<ResumenPresupuesto> {
    const evento = await this.eventos.buscarPorId(eventId)
    // Solo lo alcanza un ADMIN sobre un id inexistente: el guard ya dio 404 al resto.
    if (evento === null) throw new NotFoundError('El evento no existe')
    const hoy = hoyEnZona(this.ahora(), evento.timezone)
    const [sumas, porCategoria, overdue, proximos] = await Promise.all([
      this.gastos.sumas(eventId),
      this.gastos.sumasPorCategoria(eventId),
      this.gastos.vencidos(eventId, hoy),
      this.gastos.proximos(eventId, hoy, PROXIMOS),
    ])
    return {
      ...calcularResumen({
        currency: evento.currency,
        totalBudget: evento.totalBudget,
        ...sumas,
        porCategoria,
      }),
      overdue,
      upcoming: proximos.map((g) => ({ ...g, overdue: estaVencido(g, hoy) })),
    }
  }
}
