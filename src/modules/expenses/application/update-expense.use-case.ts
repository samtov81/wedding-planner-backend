import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import {
  NOTIFICATION_PORT,
  type NotificationPort,
} from '@/modules/notifications/application/notification.port'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import { SubidaDeFacturas } from '@/modules/storage/application/subida-de-facturas'

import { paidAtTrasCambio, subtotalValido } from '../domain/expense'
import type { ArchivoFactura, Expense } from '../domain/expense'
import {
  GastoNoEncontradoError,
  ProveedorDelEventoNoEncontradoError,
  SubtotalInvalidoError,
} from '../domain/expense-errors'
import { type ArchivoSubido, confirmarArchivo } from './archivos-de-factura.use-cases'
import { avisosDelCambio, encolarAvisoGasto } from './avisos-gastos'
import { type CambiosGasto, EXPENSE_REPOSITORY, type ExpenseRepository } from './expense.repository'

/** `invoiceFile`: ausente = no se toca; `null` = quitarlo; `{ key, name }` = reemplazarlo. */
export type EntradaCambiosGasto = Omit<CambiosGasto, 'paidAt' | 'invoiceFile'> & {
  invoiceFile?: ArchivoSubido | null | undefined
}

/**
 * Edita un gasto (spec 2026-11-11 §8 y §9), en este orden:
 *  1. si trae archivo, `confirmar` en R2 ANTES de abrir la transacción (ver
 *     `CreateExpenseUseCase`);
 *  2. unidad de trabajo: releer el gasto → proveedor del evento → subtotal
 *     con los valores FINALES (lo que llega o, si no llega, lo guardado; un
 *     PATCH que sólo baja `amount` por debajo del `subtotal` guardado es 422 y
 *     no un 500 del CHECK) → escribir → destinatarios y campana con el gasto de
 *     antes y el de después (`avisosDelCambio`);
 *  3. tras el commit, encolar siempre y, si el archivo se reemplazó o se quitó,
 *     borrar el anterior de R2. Si la escritura falla no se llega aquí: el
 *     archivo anterior sigue siendo el de la fila y no se borra.
 *
 * Reenviar la misma key (p. ej. para cambiar sólo el nombre) no es reemplazar:
 * borrarla dejaría la fila apuntando a un objeto que ya no existe.
 */
@Injectable()
export class UpdateExpenseUseCase {
  private readonly registro = new Logger(UpdateExpenseUseCase.name)

  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository,
    private readonly subidas: SubidaDeFacturas,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(NOTIFICATION_PORT) private readonly avisos: NotificationPort,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(
    eventId: string,
    expenseId: string,
    entrada: EntradaCambiosGasto,
  ): Promise<Expense> {
    const { invoiceFile, ...cambios } = entrada
    let archivo: ArchivoFactura | null | undefined = invoiceFile === null ? null : undefined
    if (invoiceFile !== undefined && invoiceFile !== null) {
      archivo = await confirmarArchivo(this.subidas, eventId, invoiceFile)
    }

    const { gasto, job, keyABorrar } = await this.unidadDeTrabajo.ejecutar(async () => {
      const actual = await this.gastos.buscarPorId(eventId, expenseId)
      if (actual === null) throw new GastoNoEncontradoError()
      if (
        cambios.origen?.kind === 'vendor' &&
        !(await this.gastos.proveedorExiste(eventId, cambios.origen.eventVendorId))
      ) {
        throw new ProveedorDelEventoNoEncontradoError()
      }
      const subtotalFinal = cambios.subtotal === undefined ? actual.subtotal : cambios.subtotal
      if (!subtotalValido(cambios.amount ?? actual.amount, subtotalFinal)) {
        throw new SubtotalInvalidoError()
      }
      // `paidAt` sólo se recalcula cuando el PATCH trae `status`: si no, un
      // cambio de `{notes}` concurrente con un `{status:'PAID'}` de otra
      // petición pisaría el `paidAt` recién fijado con uno calculado sobre esta
      // lectura, ya obsoleta.
      const gasto = await this.gastos.actualizar(eventId, expenseId, {
        ...cambios,
        ...(archivo !== undefined ? { invoiceFile: archivo } : {}),
        ...(cambios.status !== undefined
          ? { paidAt: paidAtTrasCambio(actual, cambios.status, new Date()) }
          : {}),
      })
      const keyAnterior = actual.invoiceFile?.key ?? null
      return {
        gasto,
        job: await avisosDelCambio(this.gastos, this.avisos, eventId, actual, gasto),
        keyABorrar:
          archivo !== undefined && keyAnterior !== null && keyAnterior !== archivo?.key
            ? keyAnterior
            : null,
      }
    })
    await encolarAvisoGasto(this.cola, this.registro, gasto.id, job)
    if (keyABorrar !== null) await this.subidas.borrar(keyABorrar)
    return gasto
  }
}
