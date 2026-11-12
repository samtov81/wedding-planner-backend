import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import { SubidaDeFacturas } from '@/modules/storage/application/subida-de-facturas'

import { GastoNoEncontradoError } from '../domain/expense-errors'
import { avisosDelCambio, encolarAvisoGasto } from './avisos-gastos'
import { EXPENSE_REPOSITORY, type ExpenseRepository } from './expense.repository'

/**
 * Borra un gasto (spec 2026-11-11 §9). Dentro de la unidad de trabajo relee el
 * gasto (hace falta su estado, su proveedor y su archivo de ANTES: después ya
 * no hay fila) y lo borra. Borrar no crea campana: sólo avisa al proveedor
 * cobrado si estaba PAID (`avisosDelCambio` con `despues = null`), que ya no
 * lo verá. Tras el commit encola siempre y borra el archivo de R2 si lo tenía.
 *
 * No necesita `NOTIFICATION_PORT`: con `despues = null` no hay campana posible.
 */
@Injectable()
export class DeleteExpenseUseCase {
  private readonly registro = new Logger(DeleteExpenseUseCase.name)

  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository,
    private readonly subidas: SubidaDeFacturas,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(eventId: string, expenseId: string): Promise<void> {
    const { job, keyABorrar } = await this.unidadDeTrabajo.ejecutar(async () => {
      const actual = await this.gastos.buscarPorId(eventId, expenseId)
      if (actual === null || !(await this.gastos.eliminar(eventId, expenseId))) {
        throw new GastoNoEncontradoError()
      }
      return {
        job: await avisosDelCambio(this.gastos, sinCampana, eventId, actual, null),
        keyABorrar: actual.invoiceFile?.key ?? null,
      }
    })
    await encolarAvisoGasto(this.cola, this.registro, expenseId, job)
    if (keyABorrar !== null) await this.subidas.borrar(keyABorrar)
  }
}

/** Con `despues = null` `avisosDelCambio` nunca crea campana; si lo hiciera, es un error de programación. */
const sinCampana = {
  crearParaUsuarios(): Promise<void> {
    return Promise.reject(new Error('Borrar un gasto no crea campana'))
  },
}
