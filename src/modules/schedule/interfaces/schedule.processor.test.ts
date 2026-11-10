import { Logger } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'

import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { RealtimePortEnMemoria } from '@/modules/notifications/infrastructure/realtime.port.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import {
  COLA_CRONOGRAMA,
  EVENTO_CAMPANA,
  EVENTO_RECORDATORIO,
  jobIdDeRecordatorio,
  type JobRecordatorio,
} from '../application/avisos-cronograma'
import { AsignarProveedoresUseCase } from '../application/participacion.use-cases'
import { UpdateScheduleItemUseCase } from '../application/update-schedule-item.use-case'
import type { ScheduleItem } from '../domain/schedule-item'
import { ScheduleItemRepositoryEnMemoria } from '../infrastructure/schedule-item.repository.fake'
import { ScheduleProcessor } from './schedule.processor'

/** Clave de metadata de `@Processor` (no exportada por `@nestjs/bullmq`). */
const PROCESSOR_METADATA = 'bullmq:processor_metadata'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const PLANNER_ID = '33333333-3333-4333-8333-333333333333'
const PROV_A = '55555555-5555-4555-8555-555555555555'
const PROV_B = '66666666-6666-4666-8666-666666666666'
const EV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NO_EXISTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const PLANIFICADOR = { userId: PLANNER_ID, esPlanner: true }
const HORA_MS = 3_600_000

const job = (name: string, data: unknown): Job =>
  ({ name, data, attemptsMade: 0, opts: { attempts: 5 } }) as Job

const recordatorio = (item: ScheduleItem, startsAt = item.startsAt): JobRecordatorio => ({
  itemId: item.id,
  eventVendorId: EV_A,
  startsAt: startsAt.toISOString(),
})

describe('ScheduleProcessor', () => {
  let repo: ScheduleItemRepositoryEnMemoria
  let avisos: NotificationPortEnMemoria
  let realtime: RealtimePortEnMemoria
  let procesador: ScheduleProcessor
  let item: ScheduleItem

  beforeEach(async () => {
    repo = new ScheduleItemRepositoryEnMemoria()
    repo.sembrarEvento(EVENTO, { status: 'ACTIVE' })
    repo.sembrarContratacion({
      id: EV_A,
      eventId: EVENTO,
      userId: PROV_A,
      name: 'Ana Flores',
      categoryName: 'Flores',
      status: 'BOOKED',
    })
    item = await repo.crear({
      eventId: EVENTO,
      title: 'Ceremonia',
      description: null,
      startsAt: new Date(Date.now() + 2 * HORA_MS),
      endsAt: null,
      location: null,
      status: 'PENDING',
    })
    await repo.fijarAsignaciones(item.id, [EV_A], PLANNER_ID)
    avisos = new NotificationPortEnMemoria()
    realtime = new RealtimePortEnMemoria()
    procesador = new ScheduleProcessor(repo, avisos, realtime)
  })

  it('escucha la cola PROPIA del módulo, `schedule`', () => {
    expect(COLA_CRONOGRAMA).toBe('schedule')
    expect(Reflect.getMetadata(PROCESSOR_METADATA, ScheduleProcessor)).toMatchObject({
      name: 'schedule',
    })
  })

  describe('schedule.item.reminder', () => {
    it('vigente: crea la campana al usuario de la ficha y la empuja por user:<id>', async () => {
      await procesador.process(job(EVENTO_RECORDATORIO, recordatorio(item)))

      expect(avisos.creadas).toEqual([
        {
          eventId: EVENTO,
          userId: PROV_A,
          tipo: 'schedule.item.reminder',
          payload: {
            scheduleItemId: item.id,
            title: 'Ceremonia',
            startsAt: item.startsAt.toISOString(),
          },
        },
      ])
      expect(realtime.emitidas).toEqual([
        {
          destino: { userId: PROV_A },
          tipo: 'notification.created',
          payload: { eventId: EVENTO, type: 'schedule.item.reminder' },
        },
      ])
    })

    it('Review Focus 2: A→B→A deja UN recordatorio, el de la hora A vigente', async () => {
      const unidad = new UnidadDeTrabajoEnMemoria()
      const cola = new InMemoryQueueAdapter()
      const llamadas = vi.spyOn(cola, 'enqueue')
      const asignar = new AsignarProveedoresUseCase(repo, unidad, cola)
      const editar = new UpdateScheduleItemUseCase(repo, unidad, avisos, cola)
      const horaA = item.startsAt
      const horaB = new Date(horaA.getTime() + HORA_MS)
      // Se parte de un ítem sin asignar para que la asignación encole el primer job.
      await repo.fijarAsignaciones(item.id, [], PLANNER_ID)

      await asignar.ejecutar(EVENTO, item.id, PLANIFICADOR, [EV_A])
      await editar.ejecutar(EVENTO, item.id, { startsAt: horaB }, PLANIFICADOR)
      await editar.ejecutar(EVENTO, item.id, { startsAt: horaA }, PLANIFICADOR)

      // Tres encolados de recordatorio; el primero y el tercero comparten jobId.
      const jobIds = llamadas.mock.calls
        .filter(([, nombre]) => nombre === EVENTO_RECORDATORIO)
        .map(([, , , opciones]) => opciones.jobId)
      expect(jobIds).toEqual([
        jobIdDeRecordatorio(item.id, EV_A, horaA),
        jobIdDeRecordatorio(item.id, EV_A, horaB),
        jobIdDeRecordatorio(item.id, EV_A, horaA),
      ])
      // BullMQ (y su doble) deduplica por jobId: en la cola quedan dos.
      const enCola = cola.encolados.filter((e) => e.nombre === EVENTO_RECORDATORIO)
      expect(enCola).toHaveLength(2)

      // Se ignoran las campanas de reprogramación que crearon los cambios de hora.
      avisos.creadas.length = 0
      realtime.emitidas.length = 0
      for (const e of enCola) await procesador.process(job(e.nombre, e.datos))

      expect(avisos.creadas).toEqual([
        expect.objectContaining({
          userId: PROV_A,
          tipo: 'schedule.item.reminder',
          payload: expect.objectContaining({ startsAt: horaA.toISOString() }) as unknown,
        }),
      ])
      expect(realtime.emitidas).toHaveLength(1)
    })

    it('Review Focus 4: el ítem ya está DONE → no avisa', async () => {
      await repo.actualizar(EVENTO, item.id, { status: 'DONE' })

      await procesador.process(job(EVENTO_RECORDATORIO, recordatorio(item)))

      expect(avisos.creadas).toEqual([])
      expect(realtime.emitidas).toEqual([])
    })

    it('en curso (IN_PROGRESS) tampoco avisa', async () => {
      await repo.actualizar(EVENTO, item.id, { status: 'IN_PROGRESS' })

      await procesador.process(job(EVENTO_RECORDATORIO, recordatorio(item)))

      expect(avisos.creadas).toEqual([])
    })

    it('procesado después de startsAt (Redis caído un rato) → no avisa', async () => {
      const tarde = new ScheduleProcessor(
        repo,
        avisos,
        realtime,
        () => new Date(item.startsAt.getTime() + 1),
      )

      await tarde.process(job(EVENTO_RECORDATORIO, recordatorio(item)))

      expect(avisos.creadas).toEqual([])
      expect(realtime.emitidas).toEqual([])
    })

    it('justo a startsAt todavía avisa', async () => {
      const justo = new ScheduleProcessor(repo, avisos, realtime, () => new Date(item.startsAt))

      await justo.process(job(EVENTO_RECORDATORIO, recordatorio(item)))

      expect(avisos.creadas).toHaveLength(1)
    })

    it('contratación CANCELLED → no avisa', async () => {
      repo.sembrarContratacion({
        id: EV_A,
        eventId: EVENTO,
        userId: PROV_A,
        name: 'Ana Flores',
        categoryName: 'Flores',
        status: 'CANCELLED',
      })

      await procesador.process(job(EVENTO_RECORDATORIO, recordatorio(item)))

      expect(avisos.creadas).toEqual([])
      expect(realtime.emitidas).toEqual([])
    })

    it('la hora del job ya no es la del ítem → no avisa', async () => {
      const vieja = new Date(item.startsAt.getTime() + HORA_MS)

      await procesador.process(job(EVENTO_RECORDATORIO, recordatorio(item, vieja)))

      expect(avisos.creadas).toEqual([])
    })

    it('ítem borrado, asignación quitada o evento no ACTIVE → no avisa', async () => {
      await procesador.process(
        job(EVENTO_RECORDATORIO, { ...recordatorio(item), itemId: NO_EXISTE }),
      )
      await repo.fijarAsignaciones(item.id, [], PLANNER_ID)
      await procesador.process(job(EVENTO_RECORDATORIO, recordatorio(item)))
      await repo.fijarAsignaciones(item.id, [EV_A], PLANNER_ID)
      repo.sembrarEvento(EVENTO, { status: 'DRAFT' })
      await procesador.process(job(EVENTO_RECORDATORIO, recordatorio(item)))

      expect(avisos.creadas).toEqual([])
      expect(realtime.emitidas).toEqual([])
    })

    it('si crear la campana falla, el error sale para que BullMQ reintente', async () => {
      avisos.fallarProximaCreacion(new Error('base de datos caída'))

      await expect(
        procesador.process(job(EVENTO_RECORDATORIO, recordatorio(item))),
      ).rejects.toThrow('base de datos caída')
      expect(realtime.emitidas).toEqual([])
    })

    it('si el empuje en vivo falla, NO reintenta: la fila ya está y un reintento la duplicaría', async () => {
      const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      realtime.fallarProximaEmision(new Error('redis caído'))

      await procesador.process(job(EVENTO_RECORDATORIO, recordatorio(item)))

      expect(avisos.creadas).toHaveLength(1)
      expect(aviso).toHaveBeenCalled()
      aviso.mockRestore()
    })
  })

  describe('schedule.bell', () => {
    it('emite notification.created { eventId, type } a cada userIds', async () => {
      await procesador.process(
        job(EVENTO_CAMPANA, {
          eventId: EVENTO,
          tipo: 'schedule.item.rescheduled',
          userIds: [PROV_A, PROV_B],
        }),
      )

      const payload = { eventId: EVENTO, type: 'schedule.item.rescheduled' }
      expect(realtime.emitidas).toEqual([
        { destino: { userId: PROV_A }, tipo: 'notification.created', payload },
        { destino: { userId: PROV_B }, tipo: 'notification.created', payload },
      ])
      expect(avisos.creadas).toEqual([])
    })

    it('los errores de emisión salen, para que BullMQ reintente', async () => {
      realtime.fallarProximaEmision(new Error('redis caído'))

      await expect(
        procesador.process(
          job(EVENTO_CAMPANA, {
            eventId: EVENTO,
            tipo: 'schedule.confirmation.requested',
            userIds: [PROV_A],
          }),
        ),
      ).rejects.toThrow('redis caído')
    })
  })

  describe('jobs irrecuperables', () => {
    it('un payload roto es irrecuperable con mensaje claro', async () => {
      const roto = procesador.process(
        job(EVENTO_RECORDATORIO, { itemId: item.id, eventVendorId: EV_A, startsAt: 'mañana' }),
      )
      await expect(roto).rejects.toBeInstanceOf(UnrecoverableError)
      await expect(roto).rejects.toThrow(`Payload inválido en el job ${EVENTO_RECORDATORIO}`)

      const rota = procesador.process(job(EVENTO_CAMPANA, null))
      await expect(rota).rejects.toBeInstanceOf(UnrecoverableError)
      await expect(rota).rejects.toThrow(`Payload inválido en el job ${EVENTO_CAMPANA}`)
    })

    it('un tipo de campana ajeno al cronograma es irrecuperable', async () => {
      await expect(
        procesador.process(
          job(EVENTO_CAMPANA, { eventId: EVENTO, tipo: 'otra.cosa', userIds: [PROV_A] }),
        ),
      ).rejects.toBeInstanceOf(UnrecoverableError)
    })

    it('un nombre de job desconocido es irrecuperable', async () => {
      const raro = procesador.process(job('schedule.item.deleted', {}))
      await expect(raro).rejects.toBeInstanceOf(UnrecoverableError)
      await expect(raro).rejects.toThrow(
        'Job desconocido en la cola schedule: schedule.item.deleted',
      )
    })
  })
})
