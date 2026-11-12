import { Logger } from '@nestjs/common'

import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { EventRepositoryEnMemoria } from '@/modules/events/infrastructure/event.repository.fake'
import { TIPO_GASTO_PAGADO } from '@/modules/notifications/application/notification.port'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import type { QueuePort } from '@/modules/queue/application/queue.port'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import { SubidaDeFacturas } from '@/modules/storage/application/subida-de-facturas'
import { ObjectStorageEnMemoria } from '@/modules/storage/infrastructure/object-storage.fake'

import {
  ArchivoDeFacturaNoEncontradoError,
  GastoNoEncontradoError,
  NumeroDeFacturaRepetidoError,
  PagoRecibidoNoEncontradoError,
  ProveedorDelEventoNoEncontradoError,
  SubtotalInvalidoError,
} from '../domain/expense-errors'
import { ExpenseRepositoryEnMemoria } from '../infrastructure/expense.repository.fake'
import {
  ArchivoDeGastoUseCase,
  PrepararSubidaFacturaUseCase,
} from './archivos-de-factura.use-cases'
import { COLA_GASTOS, EVENTO_GASTO_CAMBIADO, type JobGastoCambiado } from './avisos-gastos'
import { BudgetSummaryUseCase } from './budget-summary.use-case'
import { CreateExpenseUseCase } from './create-expense.use-case'
import { DeleteExpenseUseCase } from './delete-expense.use-case'
import { ListExpensesUseCase } from './list-expenses.use-case'
import { PagosRecibidosUseCase } from './pagos-recibidos.use-cases'
import { UpdateExpenseUseCase } from './update-expense.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const OTRO = '22222222-2222-4222-8222-222222222222'
const VENDOR = '33333333-3333-4333-8333-333333333333'
const VENDOR_B = '44444444-4444-4444-8444-444444444444'
const CANCELADO = '55555555-5555-4555-8555-555555555555'
const CORTO = '66666666-6666-4666-8666-666666666666'
const EXTERNO = '77777777-7777-4777-8777-777777777777'

const PROV = 'u-prov'
const PROV_B = 'u-prov-b'
const PROV_CANCELADO = 'u-cancelado'
const PROV_CORTO = 'u-corto'

/** Cola que siempre falla: Redis caído. */
class ColaRota implements QueuePort {
  enqueue(): Promise<void> {
    return Promise.reject(new Error('Redis caído'))
  }
}

function montar(opciones: { cola?: QueuePort; timezone?: string; ahora?: Date } = {}) {
  const gastos = new ExpenseRepositoryEnMemoria()
  const eventos = new EventRepositoryEnMemoria()
  eventos.eventos.push({
    id: EVENTO,
    ownerId: 'ana',
    currency: 'COP',
    totalBudget: '1000.00',
    timezone: opciones.timezone ?? 'UTC',
  })
  eventos.eventos.push({ id: OTRO, ownerId: 'ana', currency: 'EUR' })
  const ahora = () => opciones.ahora ?? new Date()
  const proveedor = (
    id: string,
    name: string,
    status: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED',
    userId: string | null,
    assignedBudget: string | null = null,
  ) => gastos.proveedores.push({ id, eventId: EVENTO, name, assignedBudget, status, userId })
  proveedor(VENDOR, 'DJ Max', 'BOOKED', PROV, '500.00')
  proveedor(VENDOR_B, 'Flores Ana', 'BOOKED', PROV_B)
  proveedor(CANCELADO, 'Catering Ex', 'CANCELLED', PROV_CANCELADO)
  proveedor(CORTO, 'Fotógrafo Quizá', 'SHORTLISTED', PROV_CORTO)
  proveedor(EXTERNO, 'Banda sin ficha', 'BOOKED', null)

  const almacen = new ObjectStorageEnMemoria()
  const subidas = new SubidaDeFacturas(almacen)
  const uow = new UnidadDeTrabajoEnMemoria()
  const avisos = new NotificationPortEnMemoria()
  const memoria = new InMemoryQueueAdapter()
  const cola = opciones.cola ?? memoria
  const preparar = new PrepararSubidaFacturaUseCase(subidas)

  /** Sube un archivo como lo haría el cliente: preparar y PUT al bucket. */
  async function subir(eventId = EVENTO): Promise<string> {
    const { key } = await preparar.ejecutar(eventId, 'application/pdf', 2048)
    almacen.simularSubida(key, 'application/pdf', 2048)
    return key
  }

  return {
    gastos,
    eventos,
    uow,
    almacen,
    avisos,
    memoria,
    subir,
    preparar,
    crear: new CreateExpenseUseCase(gastos, subidas, uow, avisos, cola, eventos, ahora),
    editar: new UpdateExpenseUseCase(gastos, subidas, uow, avisos, cola, eventos, ahora),
    borrar: new DeleteExpenseUseCase(gastos, subidas, uow, cola),
    archivo: new ArchivoDeGastoUseCase(gastos, subidas),
    listar: new ListExpensesUseCase(gastos, eventos, ahora),
    resumen: new BudgetSummaryUseCase(gastos, eventos, ahora),
    pagos: new PagosRecibidosUseCase(gastos, subidas),
    jobs: () =>
      memoria.encolados
        .filter((e) => e.cola === COLA_GASTOS && e.nombre === EVENTO_GASTO_CAMBIADO)
        .map((e) => e.datos as JobGastoCambiado),
    ultimoJob: () => {
      const job = memoria.encolados.at(-1)?.datos as JobGastoCambiado | undefined
      if (job === undefined) throw new Error('no se encoló nada')
      return job
    },
    campanas: () => avisos.creadas.filter((c) => c.tipo === TIPO_GASTO_PAGADO),
  }
}

/** Lo que sigue a `expense-<expenseId>-` en el jobId, o `null` si no empieza así. */
const marcaDe = (jobId: string | undefined, expenseId: string): string | null => {
  const prefijo = `expense-${expenseId}-`
  return jobId?.startsWith(prefijo) === true ? jobId.slice(prefijo.length) : null
}

const base = {
  concept: 'Anticipo',
  category: 'Music',
  amount: '200.00',
  dueDate: null,
  notes: null,
  invoiceNumber: null,
  subtotal: null,
  invoiceFile: null,
}

const deVendor = (eventVendorId: string) => ({
  ...base,
  origen: { kind: 'vendor' as const, eventVendorId },
})

describe('casos de uso de gastos', () => {
  it('crea un gasto de proveedor con su nombre y uno externo', async () => {
    const { crear } = montar()
    const deProveedor = await crear.ejecutar(EVENTO, deVendor(VENDOR), 'ana')
    const externo = await crear.ejecutar(
      EVENTO,
      { ...base, origen: { kind: 'external', payeeName: 'Imprenta' } },
      'ana',
    )

    expect(deProveedor.origen).toEqual({
      kind: 'vendor',
      eventVendorId: VENDOR,
      vendorName: 'DJ Max',
    })
    expect(externo).toMatchObject({
      origen: { kind: 'external', payeeName: 'Imprenta' },
      status: 'PENDING',
      paidAt: null,
    })
  })

  it('un proveedor de otro evento → 404 y no crea nada', async () => {
    const { gastos, crear } = montar()
    await expect(crear.ejecutar(OTRO, deVendor(VENDOR), 'ana')).rejects.toBeInstanceOf(
      ProveedorDelEventoNoEncontradoError,
    )
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
    const { gastos, crear, resumen } = montar()
    gastos.proveedores.push({
      id: 'v2',
      eventId: EVENTO,
      name: 'Cancelado',
      assignedBudget: '999.00',
      status: 'CANCELLED',
      userId: null,
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
    await crear.ejecutar(EVENTO, { ...deVendor(VENDOR), amount: '100.00' }, 'ana')

    expect(await resumen.ejecutar(EVENTO)).toEqual({
      currency: 'COP',
      totalBudget: '1000.00',
      assigned: '500.00',
      unassigned: '500.00',
      paid: '0.30',
      pending: '100.00',
      remaining: '899.70',
      byCategory: [
        { category: 'Music', paid: '0.30', pending: '100.00', total: '100.30', count: 3 },
      ],
      overdue: { amount: '0.00', count: 0 },
      upcoming: [],
    })
  })

  describe('vencidos y próximos (spec 2026-11-11 §6)', () => {
    const externo = (payeeName: string, dueDate: string, amount = '10.00') => ({
      ...base,
      amount,
      dueDate: new Date(`${dueDate}T00:00:00.000Z`),
      origen: { kind: 'external' as const, payeeName },
    })

    it('"hoy" es el de la zona del evento: en Caracas a las 03:00Z aún es el día 10', async () => {
      const { crear, listar } = montar({
        timezone: 'America/Caracas',
        ahora: new Date('2026-11-11T03:00:00Z'),
      })
      const dia10 = await crear.ejecutar(EVENTO, externo('A', '2026-11-10'), 'ana')
      const dia09 = await crear.ejecutar(EVENTO, externo('B', '2026-11-09'), 'ana')
      // La respuesta de crear ya lo calcula con la zona del evento.
      expect(dia10.overdue).toBe(false)
      expect(dia09.overdue).toBe(true)

      const pagina = await listar.ejecutar(
        EVENTO,
        { status: null, origin: null, eventVendorId: null, q: null },
        null,
        50,
      )
      expect(Object.fromEntries(pagina.items.map((g) => [g.id, g.overdue]))).toEqual({
        [dia10.id]: false,
        [dia09.id]: true,
      })
      const vencidos = await listar.ejecutar(
        EVENTO,
        { status: 'OVERDUE', origin: null, eventVendorId: null, q: null },
        null,
        50,
      )
      expect(vencidos.items.map((g) => g.id)).toEqual([dia09.id])
    })

    it('el mismo instante en UTC ya es día 11: el del 10 sí está vencido', async () => {
      const { crear } = montar({ ahora: new Date('2026-11-11T03:00:00Z') })
      expect((await crear.ejecutar(EVENTO, externo('A', '2026-11-10'), 'ana')).overdue).toBe(true)
    })

    it('editar devuelve overdue con la zona del evento y un PAID nunca está vencido', async () => {
      const { crear, editar } = montar({ ahora: new Date('2026-11-11T12:00:00Z') })
      const g = await crear.ejecutar(EVENTO, externo('A', '2026-11-01'), 'ana')
      expect(g.overdue).toBe(true)
      expect((await editar.ejecutar(EVENTO, g.id, { status: 'PAID' })).overdue).toBe(false)
    })

    it('el resumen lleva vencidos (suma y número) y los 5 próximos más cercanos', async () => {
      const { crear, resumen } = montar({ ahora: new Date('2026-11-11T12:00:00Z') })
      await crear.ejecutar(EVENTO, externo('V1', '2026-11-01', '10.10'), 'ana')
      await crear.ejecutar(EVENTO, externo('V2', '2026-11-10', '0.20'), 'ana')
      for (const dia of ['20', '12', '11', '30', '15', '25', '13']) {
        await crear.ejecutar(EVENTO, externo(`P${dia}`, `2026-11-${dia}`), 'ana')
      }

      const r = await resumen.ejecutar(EVENTO)

      expect(r.overdue).toEqual({ amount: '10.30', count: 2 })
      expect(r.upcoming.map((g) => g.dueDate?.toISOString().slice(0, 10))).toEqual([
        '2026-11-11',
        '2026-11-12',
        '2026-11-13',
        '2026-11-15',
        '2026-11-20',
      ])
      expect(r.upcoming.every((g) => !g.overdue)).toBe(true)
    })
  })

  describe('pagos recibidos del proveedor', () => {
    function conPagos() {
      const m = montar()
      m.gastos.eventos.push(
        { id: EVENTO, name: 'Boda A', currency: 'COP' },
        { id: OTRO, name: 'Boda B', currency: 'EUR' },
      )
      m.gastos.proveedores.push({
        id: 'vb',
        eventId: OTRO,
        name: 'DJ Max',
        assignedBudget: null,
        status: 'BOOKED',
        userId: PROV,
      })
      return m
    }
    const pagado = (eventVendorId: string, amount: string, concept = 'Pago') => ({
      ...deVendor(eventVendorId),
      concept,
      amount,
      status: 'PAID' as const,
    })

    it('listar agrupa por evento, suma totalReceived y ordena por el pago más reciente', async () => {
      const { crear, gastos, pagos } = conPagos()
      const a1 = await crear.ejecutar(EVENTO, pagado(VENDOR, '0.10', 'A1'), 'ana')
      const b1 = await crear.ejecutar(OTRO, pagado('vb', '50.00', 'B1'), 'ana')
      const a2 = await crear.ejecutar(EVENTO, pagado(VENDOR, '0.20', 'A2'), 'ana')
      const ajeno = await crear.ejecutar(EVENTO, pagado(VENDOR_B, '999.00', 'Ajeno'), 'ana')
      const fecha = (id: string, iso: string) => {
        const g = gastos.gastos.find((x) => x.id === id)
        if (g !== undefined) g.paidAt = new Date(iso)
      }
      fecha(a1.id, '2026-11-01T10:00:00Z')
      fecha(b1.id, '2026-11-03T10:00:00Z')
      fecha(a2.id, '2026-11-02T10:00:00Z')
      fecha(ajeno.id, '2026-11-04T10:00:00Z')

      const r = await pagos.listar(PROV, null)

      expect(r.map((e) => [e.eventId, e.eventName, e.currency, e.totalReceived])).toEqual([
        [OTRO, 'Boda B', 'EUR', '50.00'],
        [EVENTO, 'Boda A', 'COP', '0.30'],
      ])
      expect(r[1]?.payments.map((p) => p.concept)).toEqual(['A2', 'A1'])
      expect((await pagos.listar(PROV, EVENTO)).map((e) => e.eventId)).toEqual([EVENTO])
      expect(await pagos.listar(PROV_CORTO, null)).toEqual([])
    })

    it('archivo: ajeno → VENDOR_PAYMENT_NOT_FOUND; propio sin archivo → INVOICE_FILE_NOT_FOUND', async () => {
      const { crear, pagos, subir } = conPagos()
      const ajeno = await crear.ejecutar(EVENTO, pagado(VENDOR_B, '10.00'), 'ana')
      const sin = await crear.ejecutar(EVENTO, pagado(VENDOR, '10.00'), 'ana')
      const key = await subir()
      const con = await crear.ejecutar(
        EVENTO,
        { ...pagado(VENDOR, '10.00'), invoiceFile: { key, name: 'f.pdf' } },
        'ana',
      )

      await expect(pagos.archivo(PROV, ajeno.id)).rejects.toBeInstanceOf(
        PagoRecibidoNoEncontradoError,
      )
      await expect(pagos.archivo(PROV, sin.id)).rejects.toBeInstanceOf(
        ArchivoDeFacturaNoEncontradoError,
      )
      expect((await pagos.archivo(PROV, con.id)).url).toContain(key)
    })
  })

  describe('campana expense.paid y avisos en cola', () => {
    it('crear PAID a un proveedor BOOKED crea la campana y encola con `campanaA` y `proveedoresA`', async () => {
      const { crear, campanas, jobs, memoria } = montar()
      const gasto = await crear.ejecutar(
        EVENTO,
        { ...deVendor(VENDOR), status: 'PAID', concept: 'Sonido' },
        'ana',
      )

      expect(campanas()).toEqual([
        {
          eventId: EVENTO,
          userId: PROV,
          tipo: TIPO_GASTO_PAGADO,
          payload: { expenseId: gasto.id, concept: 'Sonido' },
        },
      ])
      expect(jobs()).toEqual([{ eventId: EVENTO, proveedoresA: [PROV], campanaA: [PROV] }])
      expect(marcaDe(memoria.encolados[0]?.jobId, gasto.id)).toMatch(/^\d+$/)
    })

    it('crear PENDING no crea campana; encola con listas vacías', async () => {
      const { crear, campanas, jobs } = montar()
      await crear.ejecutar(EVENTO, deVendor(VENDOR), 'ana')

      expect(campanas()).toEqual([])
      expect(jobs()).toEqual([{ eventId: EVENTO, proveedoresA: [], campanaA: [] }])
    })

    it('pasar a PAID a un CANCELLED no crea campana pero sí lo pone en `proveedoresA`', async () => {
      const { crear, editar, campanas, ultimoJob } = montar()
      const gasto = await crear.ejecutar(EVENTO, deVendor(CANCELADO), 'ana')
      await editar.ejecutar(EVENTO, gasto.id, { status: 'PAID' })

      expect(campanas()).toEqual([])
      expect(ultimoJob()).toEqual({
        eventId: EVENTO,
        proveedoresA: [PROV_CANCELADO],
        campanaA: [],
      })
    })

    it('pasar a PAID a un SHORTLISTED o a un externo no avisa a nadie', async () => {
      const { crear, editar, campanas, jobs } = montar()
      for (const origen of [
        { kind: 'vendor' as const, eventVendorId: CORTO },
        { kind: 'vendor' as const, eventVendorId: EXTERNO },
        { kind: 'external' as const, payeeName: 'Imprenta' },
      ]) {
        const gasto = await crear.ejecutar(EVENTO, { ...base, origen }, 'ana')
        await editar.ejecutar(EVENTO, gasto.id, { status: 'PAID' })
      }

      expect(campanas()).toEqual([])
      expect(jobs()).toHaveLength(6)
      for (const job of jobs())
        expect(job).toEqual({ eventId: EVENTO, proveedoresA: [], campanaA: [] })
    })

    it('editar un gasto ya PAID no crea campana y sí avisa al proveedor', async () => {
      const { crear, editar, campanas, ultimoJob } = montar()
      const gasto = await crear.ejecutar(EVENTO, { ...deVendor(VENDOR), status: 'PAID' }, 'ana')
      await editar.ejecutar(EVENTO, gasto.id, { concept: 'Sonido y luces' })

      expect(campanas()).toHaveLength(1)
      expect(ultimoJob()).toEqual({ eventId: EVENTO, proveedoresA: [PROV], campanaA: [] })
    })

    it('volver a PENDING y borrar un PAID avisan al proveedor sin campana', async () => {
      const { crear, editar, borrar, campanas, ultimoJob, memoria } = montar()
      const vuelve = await crear.ejecutar(EVENTO, { ...deVendor(VENDOR), status: 'PAID' }, 'ana')
      const seBorra = await crear.ejecutar(EVENTO, { ...deVendor(VENDOR), status: 'PAID' }, 'ana')

      await editar.ejecutar(EVENTO, vuelve.id, { status: 'PENDING' })
      expect(ultimoJob()).toEqual({ eventId: EVENTO, proveedoresA: [PROV], campanaA: [] })

      await borrar.ejecutar(EVENTO, seBorra.id)
      expect(ultimoJob()).toEqual({ eventId: EVENTO, proveedoresA: [PROV], campanaA: [] })
      expect(marcaDe(memoria.encolados.at(-1)?.jobId, seBorra.id)).toMatch(/^\d+$/)

      // Sólo las dos de crear ya PAID.
      expect(campanas()).toHaveLength(2)
    })

    it('cambiar de proveedor un gasto pagado avisa a los dos', async () => {
      const { crear, editar, campanas, ultimoJob } = montar()
      const gasto = await crear.ejecutar(
        EVENTO,
        { ...deVendor(VENDOR), status: 'PAID', concept: 'Sonido' },
        'ana',
      )
      await editar.ejecutar(EVENTO, gasto.id, {
        origen: { kind: 'vendor', eventVendorId: VENDOR_B },
      })

      expect(ultimoJob()).toEqual({
        eventId: EVENTO,
        proveedoresA: [PROV, PROV_B],
        campanaA: [PROV_B],
      })
      expect(campanas().map((c) => c.userId)).toEqual([PROV, PROV_B])
    })

    it('editar dos veces el mismo gasto en el mismo ms encola dos avisos', async () => {
      // El jobId lleva una marca estrictamente creciente: con `Date.now()` a
      // secas, BullMQ descartaría el segundo y su `proveedoresA` se perdería.
      const { crear, editar, jobs } = montar()
      const gasto = await crear.ejecutar(EVENTO, deVendor(VENDOR), 'ana')
      await Promise.all([
        editar.ejecutar(EVENTO, gasto.id, { notes: 'a' }),
        editar.ejecutar(EVENTO, gasto.id, { notes: 'b' }),
      ])
      expect(jobs()).toHaveLength(3)
    })
  })

  it('editar y borrar bloquean el gasto dentro de la unidad de trabajo', async () => {
    // El "antes" que decide campana y subtotal tiene que salir del bloqueo,
    // no de una lectura fuera de la transacción.
    const { crear, editar, borrar, gastos, uow } = montar()
    const gasto = await crear.ejecutar(EVENTO, deVendor(VENDOR), 'ana')
    const dentro: boolean[] = []
    vi.spyOn(gastos, 'bloquearGasto').mockImplementation((eventId, expenseId) => {
      dentro.push(uow.activa)
      return gastos.buscarPorId(eventId, expenseId)
    })

    await editar.ejecutar(EVENTO, gasto.id, { status: 'PAID' })
    await borrar.ejecutar(EVENTO, gasto.id)

    expect(dentro).toEqual([true, true])
  })

  describe('número de factura y subtotal', () => {
    it('crear guarda número y subtotal', async () => {
      const { crear } = montar()
      const gasto = await crear.ejecutar(
        EVENTO,
        { ...deVendor(VENDOR), invoiceNumber: 'F-1', subtotal: '150.00' },
        'ana',
      )
      expect(gasto).toMatchObject({ invoiceNumber: 'F-1', subtotal: '150.00' })
    })

    it('crear con subtotal mayor que el importe es 422 y no escribe', async () => {
      const { crear, gastos, jobs } = montar()
      await expect(
        crear.ejecutar(EVENTO, { ...deVendor(VENDOR), subtotal: '200.01' }, 'ana'),
      ).rejects.toBeInstanceOf(SubtotalInvalidoError)
      expect(gastos.gastos).toHaveLength(0)
      expect(jobs()).toEqual([])
    })

    it('bajar el importe por debajo del subtotal guardado es 422', async () => {
      const { crear, editar, gastos } = montar()
      const gasto = await crear.ejecutar(EVENTO, { ...deVendor(VENDOR), subtotal: '150.00' }, 'ana')

      await expect(editar.ejecutar(EVENTO, gasto.id, { amount: '100.00' })).rejects.toMatchObject({
        code: 'INVALID_SUBTOTAL',
        httpStatus: 422,
      })
      expect(gastos.gastos[0]?.amount).toBe('200.00')
    })

    it('quitar el subtotal permite bajar el importe', async () => {
      const { crear, editar } = montar()
      const gasto = await crear.ejecutar(EVENTO, { ...deVendor(VENDOR), subtotal: '150.00' }, 'ana')
      const editado = await editar.ejecutar(EVENTO, gasto.id, { amount: '100.00', subtotal: null })
      expect(editado).toMatchObject({ amount: '100.00', subtotal: null })
    })
  })

  describe('archivo de factura', () => {
    it('crear con archivo guarda lo que dice R2 y el nombre original', async () => {
      const { crear, subir } = montar()
      const key = await subir()
      const gasto = await crear.ejecutar(
        EVENTO,
        { ...deVendor(VENDOR), invoiceFile: { key, name: 'factura-marzo.pdf' } },
        'ana',
      )
      expect(key.startsWith(`events/${EVENTO}/invoices/`)).toBe(true)
      expect(gasto.invoiceFile).toEqual({
        key,
        name: 'factura-marzo.pdf',
        contentType: 'application/pdf',
        bytes: 2048,
      })
    })

    it('una key de otro evento es `INVALID_UPLOAD`', async () => {
      const { crear, editar, subir, gastos } = montar()
      const ajena = await subir(OTRO)
      await expect(
        crear.ejecutar(
          EVENTO,
          { ...deVendor(VENDOR), invoiceFile: { key: ajena, name: 'x.pdf' } },
          'ana',
        ),
      ).rejects.toMatchObject({ code: 'INVALID_UPLOAD' })
      expect(gastos.gastos).toHaveLength(0)

      const gasto = await crear.ejecutar(EVENTO, deVendor(VENDOR), 'ana')
      await expect(
        editar.ejecutar(EVENTO, gasto.id, { invoiceFile: { key: ajena, name: 'x.pdf' } }),
      ).rejects.toMatchObject({ code: 'INVALID_UPLOAD' })
      expect(gastos.gastos[0]?.invoiceFile).toBeNull()
    })

    it('reemplazar el archivo borra el anterior tras el commit', async () => {
      const { crear, editar, subir, almacen } = montar()
      const vieja = await subir()
      const gasto = await crear.ejecutar(
        EVENTO,
        { ...deVendor(VENDOR), invoiceFile: { key: vieja, name: 'v1.pdf' } },
        'ana',
      )
      const nueva = await subir()

      const editado = await editar.ejecutar(EVENTO, gasto.id, {
        invoiceFile: { key: nueva, name: 'v2.pdf' },
      })

      expect(editado.invoiceFile?.key).toBe(nueva)
      expect(almacen.borradas).toEqual([vieja])
    })

    it('quitar el archivo lo borra; reenviar el mismo no', async () => {
      const { crear, editar, subir, almacen } = montar()
      const key = await subir()
      const gasto = await crear.ejecutar(
        EVENTO,
        { ...deVendor(VENDOR), invoiceFile: { key, name: 'f.pdf' } },
        'ana',
      )

      await editar.ejecutar(EVENTO, gasto.id, { invoiceFile: { key, name: 'renombrada.pdf' } })
      expect(almacen.borradas).toEqual([])

      const sin = await editar.ejecutar(EVENTO, gasto.id, { invoiceFile: null })
      expect(sin.invoiceFile).toBeNull()
      expect(almacen.borradas).toEqual([key])
    })

    it('borrar un gasto con archivo lo borra de R2', async () => {
      const { crear, borrar, subir, almacen } = montar()
      const key = await subir()
      const gasto = await crear.ejecutar(
        EVENTO,
        { ...deVendor(VENDOR), invoiceFile: { key, name: 'f.pdf' } },
        'ana',
      )
      await borrar.ejecutar(EVENTO, gasto.id)
      expect(almacen.borradas).toEqual([key])
    })

    it('si la escritura falla no se borra el archivo anterior', async () => {
      const { crear, editar, subir, almacen, jobs } = montar()
      await crear.ejecutar(EVENTO, { ...deVendor(VENDOR), invoiceNumber: 'F-1' }, 'ana')
      const vieja = await subir()
      const gasto = await crear.ejecutar(
        EVENTO,
        { ...deVendor(VENDOR), invoiceNumber: 'F-2', invoiceFile: { key: vieja, name: 'v1.pdf' } },
        'ana',
      )
      const nueva = await subir()
      const encoladosAntes = jobs().length

      const error = await editar
        .ejecutar(EVENTO, gasto.id, {
          invoiceNumber: 'F-1',
          invoiceFile: { key: nueva, name: 'v2.pdf' },
        })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(NumeroDeFacturaRepetidoError)
      expect(error).toMatchObject({ httpStatus: 409 })
      expect(almacen.borradas).toEqual([])
      expect(jobs()).toHaveLength(encoladosAntes)
    })

    it('borrar un gasto que no existe es 404 y no encola', async () => {
      const { borrar, jobs } = montar()
      await expect(borrar.ejecutar(EVENTO, VENDOR)).rejects.toBeInstanceOf(GastoNoEncontradoError)
      expect(jobs()).toEqual([])
    })

    it('`ArchivoDeGastoUseCase` firma con el nombre original; sin archivo da `INVOICE_FILE_NOT_FOUND`', async () => {
      const { crear, subir, archivo } = montar()
      const key = await subir()
      const con = await crear.ejecutar(
        EVENTO,
        { ...deVendor(VENDOR), invoiceFile: { key, name: 'factura marzo.pdf' } },
        'ana',
      )
      const sin = await crear.ejecutar(EVENTO, deVendor(VENDOR), 'ana')

      expect(await archivo.ejecutar(EVENTO, con.id)).toEqual({
        url: `https://almacen.test/get/${key}?as=${encodeURIComponent('factura marzo.pdf')}`,
      })
      await expect(archivo.ejecutar(EVENTO, sin.id)).rejects.toBeInstanceOf(
        ArchivoDeFacturaNoEncontradoError,
      )
      await expect(archivo.ejecutar(OTRO, con.id)).rejects.toBeInstanceOf(GastoNoEncontradoError)
    })
  })

  describe('fallo de la cola', () => {
    let aviso: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('un fallo al encolar no rompe la escritura', async () => {
      const { crear, editar, borrar, gastos, campanas } = montar({ cola: new ColaRota() })
      const gasto = await crear.ejecutar(EVENTO, { ...deVendor(VENDOR), status: 'PAID' }, 'ana')
      await editar.ejecutar(EVENTO, gasto.id, { notes: 'x' })
      const otro = await crear.ejecutar(EVENTO, deVendor(VENDOR), 'ana')
      await borrar.ejecutar(EVENTO, otro.id)

      expect(gastos.gastos).toHaveLength(1)
      expect(gastos.gastos[0]?.notes).toBe('x')
      expect(campanas()).toHaveLength(1)
      expect(aviso).toHaveBeenCalledTimes(4)
    })
  })
})
