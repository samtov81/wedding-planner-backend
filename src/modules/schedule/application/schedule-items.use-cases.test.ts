import { Logger } from '@nestjs/common'

import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import type { QueuePort } from '@/modules/queue/application/queue.port'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import {
  CambioDeEstadoNoPermitidoError,
  ItemDeCronogramaNoEncontradoError,
  RangoDeCronogramaInvalidoError,
} from '../domain/schedule-errors'
import { ScheduleItemRepositoryEnMemoria } from '../infrastructure/schedule-item.repository.fake'
import { CreateScheduleItemUseCase } from './create-schedule-item.use-case'
import { DeleteScheduleItemUseCase } from './delete-schedule-item.use-case'
import { ListScheduleItemsUseCase } from './list-schedule-items.use-case'
import { UpdateScheduleItemUseCase } from './update-schedule-item.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const OTRO = '22222222-2222-4222-8222-222222222222'
const PLANNER_ID = '33333333-3333-4333-8333-333333333333'
const PAREJA_ID = '44444444-4444-4444-8444-444444444444'
const PROV_A = '55555555-5555-4555-8555-555555555555'
const PROV_B = '66666666-6666-4666-8666-666666666666'
const EV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EV_EXTERNA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EV_OTRO_EVENTO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const PLANIFICADOR = { userId: PLANNER_ID, esPlanner: true }
const PAREJA = { userId: PAREJA_ID, esPlanner: false }

const HORA = new Date('2027-06-12T22:00:00Z')
const base = {
  title: 'Inicio de la fiesta',
  description: null,
  startsAt: HORA,
  endsAt: null,
  location: null,
}

/** Cola que siempre falla: Redis caído. */
class ColaRota implements QueuePort {
  enqueue(): Promise<void> {
    return Promise.reject(new Error('Redis caído'))
  }
}

function escenario(opciones: { cola?: QueuePort } = {}) {
  const repo = new ScheduleItemRepositoryEnMemoria()
  repo.sembrarEvento(EVENTO, { status: 'ACTIVE' })
  repo.sembrarEvento(OTRO, { status: 'ACTIVE' })
  const contratada = (id: string, eventId: string, userId: string | null, name: string) =>
    repo.sembrarContratacion({
      id,
      eventId,
      userId,
      name,
      categoryName: 'Flores',
      status: 'BOOKED',
    })
  contratada(EV_A, EVENTO, PROV_A, 'Ana Flores')
  contratada(EV_B, EVENTO, PROV_B, 'Bea Música')
  contratada(EV_EXTERNA, EVENTO, null, 'Primo DJ')
  contratada(EV_OTRO_EVENTO, OTRO, PROV_A, 'Ana Flores')

  const unidad = new UnidadDeTrabajoEnMemoria()
  const avisos = new NotificationPortEnMemoria()
  const enCola = new InMemoryQueueAdapter()
  const cola = opciones.cola ?? enCola
  return {
    repo,
    unidad,
    avisos,
    cola: enCola,
    crear: new CreateScheduleItemUseCase(repo, unidad, cola),
    editar: new UpdateScheduleItemUseCase(repo, unidad, avisos, cola),
    listar: new ListScheduleItemsUseCase(repo),
    borrar: new DeleteScheduleItemUseCase(repo),
  }
}

describe('casos de uso del cronograma', () => {
  it('crea en PENDING por defecto y lista ordenado por hora', async () => {
    const { crear, listar } = escenario()
    await crear.ejecutar(EVENTO, { ...base, title: 'Fiesta' }, PLANIFICADOR)
    await crear.ejecutar(
      EVENTO,
      { ...base, title: 'Ceremonia', startsAt: new Date('2027-06-12T18:00:00Z') },
      PLANIFICADOR,
    )

    const lista = await listar.ejecutar(EVENTO, true)

    expect(lista.map((i) => [i.title, i.status])).toEqual([
      ['Ceremonia', 'PENDING'],
      ['Fiesta', 'PENDING'],
    ])
  })

  it('PATCH que deja el fin antes del inicio guardado → 422', async () => {
    const { crear, editar } = escenario()
    const item = await crear.ejecutar(EVENTO, base, PLANIFICADOR)

    await expect(
      editar.ejecutar(EVENTO, item.id, { endsAt: new Date('2027-06-12T21:00:00Z') }, PLANIFICADOR),
    ).rejects.toBeInstanceOf(RangoDeCronogramaInvalidoError)
  })

  it('cambia el estado hasta DONE', async () => {
    const { crear, editar } = escenario()
    const item = await crear.ejecutar(EVENTO, base, PLANIFICADOR)

    const hecho = await editar.ejecutar(EVENTO, item.id, { status: 'DONE' }, PLANIFICADOR)

    expect(hecho.status).toBe('DONE')
  })

  it('quien no es planner recibe 403 al mandar `status` en un PATCH', async () => {
    const { crear, editar, repo } = escenario()
    const item = await crear.ejecutar(EVENTO, base, PLANIFICADOR)

    await expect(
      editar.ejecutar(EVENTO, item.id, { status: 'DONE' }, PAREJA),
    ).rejects.toBeInstanceOf(CambioDeEstadoNoPermitidoError)
    expect((await repo.buscarPorId(EVENTO, item.id))?.status).toBe('PENDING')
  })

  it('quien no es planner sí edita el resto del ítem', async () => {
    const { crear, editar } = escenario()
    const item = await crear.ejecutar(EVENTO, base, PAREJA)

    const editado = await editar.ejecutar(EVENTO, item.id, { title: 'Cena' }, PAREJA)

    expect(editado.title).toBe('Cena')
  })

  it('al crear, sólo el planner elige un estado distinto de PENDING', async () => {
    const { crear } = escenario()

    await expect(
      crear.ejecutar(EVENTO, { ...base, status: 'DONE' }, PAREJA),
    ).rejects.toBeInstanceOf(CambioDeEstadoNoPermitidoError)
    expect((await crear.ejecutar(EVENTO, { ...base, status: 'PENDING' }, PAREJA)).status).toBe(
      'PENDING',
    )
    expect((await crear.ejecutar(EVENTO, { ...base, status: 'DONE' }, PLANIFICADOR)).status).toBe(
      'DONE',
    )
  })

  it('un ítem de otro evento es 404 al editar y al borrar', async () => {
    const { crear, editar, borrar } = escenario()
    const item = await crear.ejecutar(OTRO, base, PLANIFICADOR)

    await expect(
      editar.ejecutar(EVENTO, item.id, { title: 'X' }, PLANIFICADOR),
    ).rejects.toBeInstanceOf(ItemDeCronogramaNoEncontradoError)
    await expect(borrar.ejecutar(EVENTO, item.id)).rejects.toBeInstanceOf(
      ItemDeCronogramaNoEncontradoError,
    )
  })

  describe('crear con proveedores', () => {
    it('la pareja que manda proveedores recibe SCHEDULE_PLANNER_ONLY y no se crea nada', async () => {
      const { crear, repo, cola } = escenario()

      await expect(crear.ejecutar(EVENTO, base, PAREJA, [EV_A])).rejects.toMatchObject({
        code: 'SCHEDULE_PLANNER_ONLY',
        httpStatus: 403,
      })
      expect(repo.items).toHaveLength(0)
      expect(cola.encolados).toHaveLength(0)
    })

    it('la pareja que manda una lista vacía también es 403: el campo es sólo del planner', async () => {
      const { crear, repo } = escenario()

      await expect(crear.ejecutar(EVENTO, base, PAREJA, [])).rejects.toMatchObject({
        code: 'SCHEDULE_PLANNER_ONLY',
      })
      expect(repo.items).toHaveLength(0)
    })

    it('una externa o una de otro evento → 422 con todos los rechazados y no se crea nada', async () => {
      const { crear, repo, cola } = escenario()

      await expect(
        crear.ejecutar(EVENTO, base, PLANIFICADOR, [EV_A, EV_EXTERNA, EV_OTRO_EVENTO]),
      ).rejects.toMatchObject({
        code: 'SCHEDULE_VENDOR_NOT_ASSIGNABLE',
        httpStatus: 422,
        details: { eventVendorIds: [EV_EXTERNA, EV_OTRO_EVENTO] },
      })
      expect(repo.items).toHaveLength(0)
      expect(repo.asignaciones).toHaveLength(0)
      expect(cola.encolados).toHaveLength(0)
    })

    it('asigna dentro de la transacción, nace sin confirmar y encola un recordatorio por alta', async () => {
      const { crear, unidad, cola } = escenario()

      const item = await crear.ejecutar(EVENTO, base, PLANIFICADOR, [EV_B, EV_A])

      expect(unidad.transacciones).toBe(1)
      expect(item.vendors).toEqual([
        { eventVendorId: EV_A, name: 'Ana Flores', categoryName: 'Flores', confirmed: false },
        { eventVendorId: EV_B, name: 'Bea Música', categoryName: 'Flores', confirmed: false },
      ])
      expect(cola.encolados.map((e) => [e.cola, e.nombre, e.jobId, e.datos])).toEqual([
        [
          'schedule',
          'schedule.item.reminder',
          `reminder-${item.id}-${EV_A}-${HORA.getTime()}`,
          { itemId: item.id, eventVendorId: EV_A, startsAt: HORA.toISOString() },
        ],
        [
          'schedule',
          'schedule.item.reminder',
          `reminder-${item.id}-${EV_B}-${HORA.getTime()}`,
          { itemId: item.id, eventVendorId: EV_B, startsAt: HORA.toISOString() },
        ],
      ])
    })

    it('el retraso del recordatorio es startsAt − 15 min − ahora', async () => {
      const { crear, cola } = escenario()
      const enUnaHora = new Date(Date.now() + 3_600_000)

      const antes = Date.now()
      await crear.ejecutar(EVENTO, { ...base, startsAt: enUnaHora }, PLANIFICADOR, [EV_A])
      const despues = Date.now()

      const retraso = cola.encolados[0]?.opciones.delayMs ?? -1
      expect(retraso).toBeGreaterThanOrEqual(enUnaHora.getTime() - 900_000 - despues)
      expect(retraso).toBeLessThanOrEqual(enUnaHora.getTime() - 900_000 - antes)
    })

    it('un ítem a menos de 15 minutos se asigna pero no programa recordatorio', async () => {
      const { crear, cola } = escenario()

      const item = await crear.ejecutar(
        EVENTO,
        { ...base, startsAt: new Date(Date.now() + 10 * 60_000) },
        PLANIFICADOR,
        [EV_A],
      )

      expect(item.vendors).toHaveLength(1)
      expect(cola.encolados).toHaveLength(0)
    })
  })

  describe('editar con reconfirmación', () => {
    async function asignadoYConfirmado(e: ReturnType<typeof escenario>) {
      const item = await e.crear.ejecutar(EVENTO, base, PLANIFICADOR, [EV_A, EV_B])
      for (const prov of [PROV_A, PROV_B]) {
        await e.repo.confirmar(EVENTO, prov, await e.repo.pendientesDe(EVENTO, prov))
      }
      e.cola.encolados.length = 0
      return item
    }

    it('editar sólo el título ni desconfirma, ni avisa, ni encola', async () => {
      const e = escenario()
      const item = await asignadoYConfirmado(e)

      const editado = await e.editar.ejecutar(EVENTO, item.id, { title: 'Baile' }, PAREJA)

      expect(editado.title).toBe('Baile')
      expect(editado.vendors.map((v) => v.confirmed)).toEqual([true, true])
      expect(e.avisos.creadas).toHaveLength(0)
      expect(e.cola.encolados).toHaveLength(0)
    })

    it('repetir la misma hora en el PATCH no cuenta como cambio', async () => {
      const e = escenario()
      const item = await asignadoYConfirmado(e)

      await e.editar.ejecutar(EVENTO, item.id, { startsAt: new Date(HORA) }, PLANIFICADOR)

      expect(e.avisos.creadas).toHaveLength(0)
      expect(e.cola.encolados).toHaveLength(0)
    })

    it('cambiar startsAt desconfirma, avisa a los asignados y reprograma con la hora nueva', async () => {
      const e = escenario()
      const item = await asignadoYConfirmado(e)
      const nueva = new Date('2027-06-12T23:00:00Z')

      const editado = await e.editar.ejecutar(EVENTO, item.id, { startsAt: nueva }, PAREJA)

      expect(editado.vendors.map((v) => v.confirmed)).toEqual([false, false])
      expect(e.avisos.creadas).toEqual([
        {
          eventId: EVENTO,
          userId: PROV_A,
          tipo: 'schedule.item.rescheduled',
          payload: { scheduleItemId: item.id, title: 'Inicio de la fiesta' },
        },
        {
          eventId: EVENTO,
          userId: PROV_B,
          tipo: 'schedule.item.rescheduled',
          payload: { scheduleItemId: item.id, title: 'Inicio de la fiesta' },
        },
      ])
      expect(e.cola.encolados.map((j) => [j.nombre, j.jobId])).toEqual([
        ['schedule.bell', expect.stringMatching(/^bell-schedule\.item\.rescheduled-/)],
        ['schedule.item.reminder', `reminder-${item.id}-${EV_A}-${nueva.getTime()}`],
        ['schedule.item.reminder', `reminder-${item.id}-${EV_B}-${nueva.getTime()}`],
      ])
      expect(e.cola.encolados[0]?.datos).toEqual({
        eventId: EVENTO,
        tipo: 'schedule.item.rescheduled',
        userIds: [PROV_A, PROV_B],
      })
    })

    it('cambiar sólo endsAt también desconfirma y avisa, con el título nuevo si cambia a la vez', async () => {
      const e = escenario()
      const item = await asignadoYConfirmado(e)

      const editado = await e.editar.ejecutar(
        EVENTO,
        item.id,
        { endsAt: new Date('2027-06-13T02:00:00Z'), title: 'Fiesta' },
        PLANIFICADOR,
      )

      expect(editado.vendors.map((v) => v.confirmed)).toEqual([false, false])
      expect(e.avisos.creadas.map((c) => c.payload)).toEqual([
        { scheduleItemId: item.id, title: 'Fiesta' },
        { scheduleItemId: item.id, title: 'Fiesta' },
      ])
    })

    it('la campana se crea dentro de la transacción y los jobs se encolan después', async () => {
      const repo = new ScheduleItemRepositoryEnMemoria()
      repo.sembrarContratacion({
        id: EV_A,
        eventId: EVENTO,
        userId: PROV_A,
        name: 'Ana Flores',
        categoryName: 'Flores',
        status: 'BOOKED',
      })
      const unidad = new UnidadDeTrabajoEnMemoria()
      const dentro: boolean[] = []
      const avisos = new (class extends NotificationPortEnMemoria {
        override crearParaUsuarios(
          ...args: Parameters<NotificationPortEnMemoria['crearParaUsuarios']>
        ) {
          dentro.push(unidad.activa)
          return super.crearParaUsuarios(...args)
        }
      })()
      const fuera: boolean[] = []
      const cola: QueuePort = {
        enqueue: () => {
          fuera.push(unidad.activa)
          return Promise.resolve()
        },
      }
      const item = await new CreateScheduleItemUseCase(repo, unidad, cola).ejecutar(
        EVENTO,
        base,
        PLANIFICADOR,
        [EV_A],
      )

      await new UpdateScheduleItemUseCase(repo, unidad, avisos, cola).ejecutar(
        EVENTO,
        item.id,
        { startsAt: new Date('2027-06-12T23:00:00Z') },
        PLANIFICADOR,
      )

      expect(dentro).toEqual([true])
      expect(fuera.length).toBeGreaterThan(0)
      expect(fuera.every((activa) => !activa)).toBe(true)
    })

    it('sin proveedores asignados, cambiar la hora no crea campana ni job de campana', async () => {
      const e = escenario()
      const item = await e.crear.ejecutar(EVENTO, base, PLANIFICADOR)

      await e.editar.ejecutar(
        EVENTO,
        item.id,
        { startsAt: new Date('2027-06-12T23:00:00Z') },
        PAREJA,
      )

      expect(e.avisos.creadas).toHaveLength(0)
      expect(e.cola.encolados).toHaveLength(0)
    })

    it('mover la hora a menos de 15 minutos desconfirma y avisa, pero no programa recordatorio', async () => {
      const e = escenario()
      const item = await asignadoYConfirmado(e)

      await e.editar.ejecutar(
        EVENTO,
        item.id,
        { startsAt: new Date(Date.now() + 5 * 60_000) },
        PLANIFICADOR,
      )

      expect(e.avisos.creadas).toHaveLength(2)
      expect(e.cola.encolados.map((j) => j.nombre)).toEqual(['schedule.bell'])
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

    it('no tumba crear con proveedores ni el cambio de hora', async () => {
      const { crear, editar, repo, avisos } = escenario({ cola: new ColaRota() })

      const item = await crear.ejecutar(EVENTO, base, PLANIFICADOR, [EV_A])
      const editado = await editar.ejecutar(
        EVENTO,
        item.id,
        { startsAt: new Date('2027-06-12T23:00:00Z') },
        PLANIFICADOR,
      )

      expect(editado.startsAt).toEqual(new Date('2027-06-12T23:00:00Z'))
      expect(repo.asignaciones).toHaveLength(1)
      expect(avisos.creadas).toHaveLength(1)
      // Un recordatorio al crear; al editar, la campana y el recordatorio nuevo.
      expect(aviso).toHaveBeenCalledTimes(3)
    })
  })
})
