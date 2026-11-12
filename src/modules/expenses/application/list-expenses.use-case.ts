import { Inject, Injectable, Optional } from '@nestjs/common'

import {
  EVENT_REPOSITORY,
  type EventRepository,
} from '@/modules/events/application/event.repository'
import { type CursorPage, type CursorValue, NotFoundError } from '@/shared/domain'

import { estaVencido, type GastoListado, hoyEnZona } from '../domain/expense'
import { EXPENSE_REPOSITORY, type ExpenseRepository, type FiltroGastos } from './expense.repository'
import { RELOJ_GASTOS, type Reloj } from './reloj'

/**
 * Lista los gastos de un evento con `overdue` calculado. "Hoy" es la fecha de
 * `ahora()` en la zona del evento (spec 2026-11-11 §8), no la del servidor: en
 * `America/Caracas` a las 03:00Z todavía es el día anterior.
 */
@Injectable()
export class ListExpensesUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository,
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
    @Optional() @Inject(RELOJ_GASTOS) private readonly ahora: Reloj = () => new Date(),
  ) {}

  async ejecutar(
    eventId: string,
    filtro: Omit<FiltroGastos, 'hoy'>,
    cursor: CursorValue | null,
    limit: number,
  ): Promise<CursorPage<GastoListado>> {
    const evento = await this.eventos.buscarPorId(eventId)
    // Solo lo alcanza un ADMIN sobre un id inexistente: el guard ya dio 404 al resto.
    if (evento === null) throw new NotFoundError('El evento no existe')
    const hoy = hoyEnZona(this.ahora(), evento.timezone)
    const pagina = await this.gastos.listar(eventId, { ...filtro, hoy }, cursor, limit)
    return {
      ...pagina,
      items: pagina.items.map((g) => ({ ...g, overdue: estaVencido(g, hoy) })),
    }
  }
}
