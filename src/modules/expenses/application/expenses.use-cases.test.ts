import { EventRepositoryEnMemoria } from '@/modules/events/infrastructure/event.repository.fake'

import {
  GastoNoEncontradoError,
  ProveedorDelEventoNoEncontradoError,
} from '../domain/expense-errors'
import { ExpenseRepositoryEnMemoria } from '../infrastructure/expense.repository.fake'
import { BudgetSummaryUseCase } from './budget-summary.use-case'
import { CreateExpenseUseCase } from './create-expense.use-case'
import { UpdateExpenseUseCase } from './update-expense.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const OTRO = '22222222-2222-4222-8222-222222222222'
const VENDOR = '33333333-3333-4333-8333-333333333333'

function montar() {
  const gastos = new ExpenseRepositoryEnMemoria()
  gastos.proveedores.push({
    id: VENDOR,
    eventId: EVENTO,
    name: 'DJ Max',
    assignedBudget: '500.00',
    status: 'BOOKED',
  })
  return {
    gastos,
    crear: new CreateExpenseUseCase(gastos),
    editar: new UpdateExpenseUseCase(gastos),
  }
}

const base = {
  concept: 'Anticipo',
  category: 'Music',
  amount: '200.00',
  dueDate: null,
  notes: null,
}

describe('casos de uso de gastos', () => {
  it('crea un gasto de proveedor con su nombre y uno externo', async () => {
    const { crear } = montar()
    const deVendor = await crear.ejecutar(
      EVENTO,
      { ...base, origen: { kind: 'vendor', eventVendorId: VENDOR } },
      'ana',
    )
    const externo = await crear.ejecutar(
      EVENTO,
      { ...base, origen: { kind: 'external', payeeName: 'Imprenta' } },
      'ana',
    )

    expect(deVendor.origen).toEqual({ kind: 'vendor', eventVendorId: VENDOR, vendorName: 'DJ Max' })
    expect(externo).toMatchObject({
      origen: { kind: 'external', payeeName: 'Imprenta' },
      status: 'PENDING',
      paidAt: null,
    })
  })

  it('un proveedor de otro evento → 404 y no crea nada', async () => {
    const { gastos, crear } = montar()
    await expect(
      crear.ejecutar(OTRO, { ...base, origen: { kind: 'vendor', eventVendorId: VENDOR } }, 'ana'),
    ).rejects.toBeInstanceOf(ProveedorDelEventoNoEncontradoError)
    expect(gastos.gastos).toHaveLength(0)
  })

  it('crear ya pagado fija paidAt; marcar pagado y revertir lo gestiona', async () => {
    const { crear, editar } = montar()
    const pagado = await crear.ejecutar(
      EVENTO,
      { ...base, status: 'PAID', origen: { kind: 'external', payeeName: 'X' } },
      'ana',
    )
    expect(pagado.paidAt).not.toBeNull()

    const revertido = await editar.ejecutar(EVENTO, pagado.id, { status: 'PENDING' })
    expect(revertido.paidAt).toBeNull()
  })

  it('un PATCH sin status no toca paidAt (no pisa un pago concurrente)', async () => {
    // `update-expense.use-case`: si `cambios.status` no llega, `paidAt` no debe
    // ir en los cambios que se pasan al repositorio. Sin este guard, un PATCH
    // de `{notes}` que corre a la vez que un `{status:'PAID'}` reescribiría
    // `paidAt` con un valor calculado sobre una lectura ya obsoleta.
    const { crear, editar, gastos } = montar()
    const pagado = await crear.ejecutar(
      EVENTO,
      { ...base, status: 'PAID', origen: { kind: 'external', payeeName: 'X' } },
      'ana',
    )
    const espia = vi.spyOn(gastos, 'actualizar')

    await editar.ejecutar(EVENTO, pagado.id, { notes: 'nueva nota' })

    expect(espia.mock.calls[0]?.[2]).not.toHaveProperty('paidAt')
  })

  it('editar un gasto de otro evento → 404', async () => {
    const { crear, editar } = montar()
    const gasto = await crear.ejecutar(
      EVENTO,
      { ...base, origen: { kind: 'external', payeeName: 'X' } },
      'ana',
    )
    await expect(editar.ejecutar(OTRO, gasto.id, { concept: 'Y' })).rejects.toBeInstanceOf(
      GastoNoEncontradoError,
    )
  })

  it('el resumen suma pagado, pendiente y asignado (sin CANCELLED)', async () => {
    const { gastos, crear } = montar()
    gastos.proveedores.push({
      id: 'v2',
      eventId: EVENTO,
      name: 'Cancelado',
      assignedBudget: '999.00',
      status: 'CANCELLED',
    })
    await crear.ejecutar(
      EVENTO,
      { ...base, amount: '0.10', status: 'PAID', origen: { kind: 'external', payeeName: 'A' } },
      'ana',
    )
    await crear.ejecutar(
      EVENTO,
      { ...base, amount: '0.20', status: 'PAID', origen: { kind: 'external', payeeName: 'B' } },
      'ana',
    )
    await crear.ejecutar(
      EVENTO,
      { ...base, amount: '100.00', origen: { kind: 'vendor', eventVendorId: VENDOR } },
      'ana',
    )

    const eventos = new EventRepositoryEnMemoria()
    eventos.eventos.push({ id: EVENTO, ownerId: 'ana', currency: 'COP', totalBudget: '1000.00' })

    expect(await new BudgetSummaryUseCase(gastos, eventos).ejecutar(EVENTO)).toEqual({
      currency: 'COP',
      totalBudget: '1000.00',
      assigned: '500.00',
      unassigned: '500.00',
      paid: '0.30',
      pending: '100.00',
      remaining: '899.70',
    })
  })
})
