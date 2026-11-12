import { randomUUID } from 'node:crypto'

import { UnrecoverableError, type Job } from 'bullmq'

import type { EventAccessService } from '@/modules/events/application/event-access.service'
import { RealtimePortEnMemoria } from '@/modules/notifications/infrastructure/realtime.port.fake'

import {
  COLA_GASTOS,
  EVENTO_GASTO_CAMBIADO,
  EVENTO_PAGO_PROVEEDOR_CAMBIADO,
  type JobGastoCambiado,
} from '../application/avisos-gastos'
import { GastosProcessor } from './expenses.processor'

/** Clave de metadata de `@Processor` (no exportada por `@nestjs/bullmq`). */
const PROCESSOR_METADATA = 'bullmq:processor_metadata'

const EVENTO = randomUUID()
const PAREJA = randomUUID()
const PLANNER = randomUUID()
const PROV = randomUUID()
const OTRO_PROV = randomUUID()

const job = (name: string, data: unknown): Job =>
  ({ name, data, attemptsMade: 0, opts: { attempts: 5 } }) as Job

describe('GastosProcessor', () => {
  let realtime: RealtimePortEnMemoria
  let conPresupuesto: string[]
  let procesador: GastosProcessor

  const cambio = (datos: Partial<JobGastoCambiado> = {}): JobGastoCambiado => ({
    eventId: EVENTO,
    proveedoresA: [],
    campanaA: [],
    ...datos,
  })

  beforeEach(() => {
    realtime = new RealtimePortEnMemoria()
    conPresupuesto = [PAREJA]
    const acceso = {
      usuariosConPresupuesto: (eventId: string) =>
        Promise.resolve(eventId === EVENTO ? conPresupuesto : []),
    } as unknown as EventAccessService
    procesador = new GastosProcessor(acceso, realtime)
  })

  it('escucha la cola PROPIA del módulo, `expenses`', () => {
    expect(COLA_GASTOS).toBe('expenses')
    expect(Reflect.getMetadata(PROCESSOR_METADATA, GastosProcessor)).toMatchObject({
      name: 'expenses',
    })
  })

  it('expense.changed a quien ve el presupuesto HOY, no a una lista del job', async () => {
    conPresupuesto = [PAREJA, PLANNER]

    await procesador.process(job(EVENTO_GASTO_CAMBIADO, cambio()))

    expect(realtime.emitidas).toEqual([
      { destino: { userId: PAREJA }, tipo: 'expense.changed', payload: { eventId: EVENTO } },
      { destino: { userId: PLANNER }, tipo: 'expense.changed', payload: { eventId: EVENTO } },
    ])
  })

  it('vendor-payment.changed a cada proveedor y notification.created a la campana', async () => {
    conPresupuesto = []

    await procesador.process(
      job(EVENTO_GASTO_CAMBIADO, cambio({ proveedoresA: [PROV, OTRO_PROV], campanaA: [PROV] })),
    )

    expect(EVENTO_PAGO_PROVEEDOR_CAMBIADO).toBe('vendor-payment.changed')
    expect(realtime.emitidas).toEqual([
      { destino: { userId: PROV }, tipo: 'vendor-payment.changed', payload: { eventId: EVENTO } },
      {
        destino: { userId: OTRO_PROV },
        tipo: 'vendor-payment.changed',
        payload: { eventId: EVENTO },
      },
      {
        destino: { userId: PROV },
        tipo: 'notification.created',
        payload: { eventId: EVENTO, type: 'expense.paid' },
      },
    ])
  })

  it('un payload roto es irrecuperable y no emite nada', async () => {
    const roto = procesador.process(job(EVENTO_GASTO_CAMBIADO, { eventId: 'no-uuid' }))
    await expect(roto).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(roto).rejects.toThrow(`Payload inválido en el job ${EVENTO_GASTO_CAMBIADO}`)
    expect(realtime.emitidas).toEqual([])
  })

  it('un nombre de job desconocido es irrecuperable', async () => {
    const raro = procesador.process(job('expense.deleted', {}))
    await expect(raro).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(raro).rejects.toThrow('Job desconocido en la cola expenses: expense.deleted')
  })

  it('los errores de emisión salen, para que BullMQ reintente', async () => {
    realtime.fallarProximaEmision(new Error('redis caído'))
    await expect(procesador.process(job(EVENTO_GASTO_CAMBIADO, cambio()))).rejects.toThrow(
      'redis caído',
    )
  })
})
