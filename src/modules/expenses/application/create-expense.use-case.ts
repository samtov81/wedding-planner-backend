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

import { type Expense, type ExpenseStatus, subtotalValido } from '../domain/expense'
import {
  ProveedorDelEventoNoEncontradoError,
  SubtotalInvalidoError,
} from '../domain/expense-errors'
import { type ArchivoSubido, confirmarArchivo } from './archivos-de-factura.use-cases'
import { avisosDelCambio, encolarAvisoGasto } from './avisos-gastos'
import {
  type DatosNuevoGasto,
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
} from './expense.repository'

export type EntradaGasto = Omit<
  DatosNuevoGasto,
  'eventId' | 'createdById' | 'paidAt' | 'status' | 'invoiceNumber' | 'subtotal' | 'invoiceFile'
> & {
  status?: ExpenseStatus | undefined
  invoiceNumber?: string | null | undefined
  subtotal?: string | null | undefined
  invoiceFile?: ArchivoSubido | null | undefined
}

/**
 * Da de alta un gasto, en este orden (spec 2026-11-11 §8 y §9):
 *  1. subtotal (`0 < subtotal <= amount`) → 422 sin tocar nada;
 *  2. si trae archivo, `confirmar` en R2 ANTES de abrir la transacción: un
 *     viaje de red dentro alargaría la transacción (mismo razonamiento que
 *     `CrearImagenUseCase` del moodboard). Se guarda lo que dice R2;
 *  3. unidad de trabajo: proveedor del evento → insertar → campana
 *     `expense.paid` si nace PAID a un proveedor BOOKED (`avisosDelCambio`);
 *  4. tras el commit, encolar `expense.changed` SIEMPRE: aunque no haya
 *     proveedor al que avisar, a quien ve el presupuesto le interesa.
 *
 * Si la escritura falla (p. ej. número de factura repetido, 409) el archivo
 * recién subido NO se borra: el cliente puede corregir el número y reintentar
 * con la misma key. Alternativa descartada: borrarlo en el fallo, que obligaría
 * a volver a subirlo.
 */
@Injectable()
export class CreateExpenseUseCase {
  private readonly registro = new Logger(CreateExpenseUseCase.name)

  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository,
    private readonly subidas: SubidaDeFacturas,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(NOTIFICATION_PORT) private readonly avisos: NotificationPort,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(eventId: string, entrada: EntradaGasto, actorId: string): Promise<Expense> {
    const { invoiceFile, invoiceNumber, subtotal, ...resto } = entrada
    if (!subtotalValido(entrada.amount, subtotal ?? null)) throw new SubtotalInvalidoError()
    const archivo =
      invoiceFile === undefined || invoiceFile === null
        ? null
        : await confirmarArchivo(this.subidas, eventId, invoiceFile)

    const status = entrada.status ?? 'PENDING'
    const { gasto, job } = await this.unidadDeTrabajo.ejecutar(async () => {
      if (
        entrada.origen.kind === 'vendor' &&
        !(await this.gastos.proveedorExiste(eventId, entrada.origen.eventVendorId))
      ) {
        throw new ProveedorDelEventoNoEncontradoError()
      }
      const gasto = await this.gastos.crear({
        ...resto,
        eventId,
        status,
        paidAt: status === 'PAID' ? new Date() : null,
        invoiceNumber: invoiceNumber ?? null,
        subtotal: subtotal ?? null,
        invoiceFile: archivo,
        createdById: actorId,
      })
      return {
        gasto,
        job: await avisosDelCambio(this.gastos, this.avisos, eventId, null, gasto),
      }
    })
    await encolarAvisoGasto(this.cola, this.registro, gasto.id, job)
    return gasto
  }
}
