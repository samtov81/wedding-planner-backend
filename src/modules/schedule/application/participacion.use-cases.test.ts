import { Logger } from '@nestjs/common'

import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import type { QueuePort } from '@/modules/queue/application/queue.port'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { ScheduleItemRepositoryEnMemoria } from '../infrastructure/schedule-item.repository.fake'
import { CreateScheduleItemUseCase } from './create-schedule-item.use-case'
import { ListScheduleItemsUseCase } from './list-schedule-items.use-case'
import {
  AsignarProveedoresUseCase,
  AvisarProveedoresUseCase,
  ConfirmacionesUseCase,
  CrearNotaUseCase,
  ListarAsignablesUseCase,
  ListarNotasUseCase,
} from './participacion.use-cases'
import { UpdateScheduleItemUseCase } from './update-schedule-item.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const OTRO = '22222222-2222-4222-8222-222222222222'
const PLANNER_ID = '33333333-3333-4333-8333-333333333333'
const PAREJA_ID = '44444444-4444-4444-8444-444444444444'
const PROV_A = '55555555-5555-4555-8555-555555555555'
const PROV_B = '66666666-6666-4666-8666-666666666666'
const EV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EV_A2 = 'abababab-abab-4bab-8bab-abababababab'
const EV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EV_EXTERNA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EV_CANCELADA = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'
const EV_OTRO_EVENTO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const NO_EXISTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const PLANIFICADOR = { userId: PLANNER_ID, esPlanner: true }
const PAREJA = { userId: PAREJA_ID, esPlanner: false }

const HORA = new Date('2027-06-12T22:00:00Z')
const base = {
  title: 'Fiesta',
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
  repo.sembrarUsuario({ id: PLANNER_ID, name: 'Paula Planner', avatarKey: 'avatars/paula' })
  const contratacion = (
    id: string,
    eventId: string,
    userId: string | null,
    name: string,
    status: 'BOOKED' | 'CANCELLED' = 'BOOKED',
  ) => repo.sembrarContratacion({ id, eventId, userId, name, categoryName: 'Flores', status })
  contratacion(EV_A, EVENTO, PROV_A, 'Ana Flores')
  contratacion(EV_A2, EVENTO, PROV_A, 'Ana Flores')
  contratacion(EV_B, EVENTO, PROV_B, 'Bea Música')
  contratacion(EV_EXTERNA, EVENTO, null, 'Primo DJ')
  contratacion(EV_CANCELADA, EVENTO, PROV_B, 'Bea Música', 'CANCELLED')
  contratacion(EV_OTRO_EVENTO, OTRO, PROV_A, 'Ana Flores')

  const unidad = new UnidadDeTrabajoEnMemoria()
  const avisos = new NotificationPortEnMemoria()
  const enCola = new InMemoryQueueAdapter()
  const cola = opciones.cola ?? enCola
  const crear = new CreateScheduleItemUseCase(repo, unidad, cola)
  return {
    repo,
    unidad,
    avisos,
    cola: enCola,
    nuevoItem: (title = 'Fiesta', startsAt = HORA) =>
      crear.ejecutar(EVENTO, { ...base, title, startsAt }, PLANIFICADOR),
    editar: new UpdateScheduleItemUseCase(repo, unidad, avisos, cola),
    asignar: new AsignarProveedoresUseCase(repo, unidad, cola),
    asignables: new ListarAsignablesUseCase(repo),
    listar: new ListScheduleItemsUseCase(repo),
    notas: new ListarNotasUseCase(repo),
    nota: new CrearNotaUseCase(repo),
    confirmaciones: new ConfirmacionesUseCase(repo, unidad),
    avisar: new AvisarProveedoresUseCase(repo, unidad, avisos, cola),
  }
}

describe('casos de uso de participación de proveedores', () => {
  describe('asignar proveedores', () => {
    it('sólo el planner: la pareja recibe 403 y no cambia nada', async () => {
      const { nuevoItem, asignar, repo } = escenario()
      const item = await nuevoItem()

      await expect(asignar.ejecutar(EVENTO, item.id, PAREJA, [EV_A])).rejects.toMatchObject({
        code: 'SCHEDULE_PLANNER_ONLY',
        httpStatus: 403,
      })
      expect(repo.asignaciones).toHaveLength(0)
    })

    it('un ítem de otro evento o inexistente es 404', async () => {
      const { asignar, repo } = escenario()
      const ajeno = await repo.crear({ ...base, eventId: OTRO, status: 'PENDING' })

      for (const id of [ajeno.id, NO_EXISTE]) {
        await expect(asignar.ejecutar(EVENTO, id, PLANIFICADOR, [EV_A])).rejects.toMatchObject({
          code: 'SCHEDULE_ITEM_NOT_FOUND',
        })
      }
    })

    it('externa, cancelada o de otro evento → 422 con todas las rechazadas y nada asignado', async () => {
      const { nuevoItem, asignar, repo, cola } = escenario()
      const item = await nuevoItem()

      await expect(
        asignar.ejecutar(EVENTO, item.id, PLANIFICADOR, [
          EV_A,
          EV_EXTERNA,
          EV_CANCELADA,
          EV_OTRO_EVENTO,
        ]),
      ).rejects.toMatchObject({
        code: 'SCHEDULE_VENDOR_NOT_ASSIGNABLE',
        httpStatus: 422,
        details: { eventVendorIds: [EV_EXTERNA, EV_CANCELADA, EV_OTRO_EVENTO] },
      })
      expect(repo.asignaciones).toHaveLength(0)
      expect(cola.encolados).toHaveLength(0)
    })

    it('fija la lista, devuelve el ítem con sus vendors y sólo encola recordatorios de las altas', async () => {
      const { nuevoItem, asignar, cola, unidad } = escenario()
      const item = await nuevoItem()
      await asignar.ejecutar(EVENTO, item.id, PLANIFICADOR, [EV_A])
      cola.encolados.length = 0
      const antes = unidad.transacciones

      const resultado = await asignar.ejecutar(EVENTO, item.id, PLANIFICADOR, [EV_B, EV_A])

      expect(unidad.transacciones).toBe(antes + 1)
      expect(resultado.vendors.map((v) => v.eventVendorId)).toEqual([EV_A, EV_B])
      expect(cola.encolados.map((j) => j.jobId)).toEqual([
        `reminder-${item.id}-${EV_B}-${HORA.getTime()}`,
      ])
    })

    it('una lista vacía desasigna a todos y no encola nada', async () => {
      const { nuevoItem, asignar, cola } = escenario()
      const item = await nuevoItem()
      await asignar.ejecutar(EVENTO, item.id, PLANIFICADOR, [EV_A, EV_B])
      cola.encolados.length = 0

      const resultado = await asignar.ejecutar(EVENTO, item.id, PLANIFICADOR, [])

      expect(resultado.vendors).toEqual([])
      expect(cola.encolados).toHaveLength(0)
    })
  })

  describe('asignables', () => {
    it('el planner ve las BOOKED con ficha del evento, por nombre', async () => {
      const { asignables } = escenario()

      const lista = await asignables.ejecutar(EVENTO, PLANIFICADOR)

      expect(lista.map((a) => a.eventVendorId)).toEqual([EV_A, EV_A2, EV_B])
    })

    it('la pareja recibe 403', async () => {
      const { asignables } = escenario()

      await expect(asignables.ejecutar(EVENTO, PAREJA)).rejects.toMatchObject({
        code: 'SCHEDULE_PLANNER_ONLY',
      })
    })
  })

  describe('listado', () => {
    it('trae vendors a todos y noteCount sólo al planner (0 si no hay notas)', async () => {
      const { nuevoItem, asignar, nota, listar } = escenario()
      const ceremonia = await nuevoItem('Ceremonia', new Date('2027-06-12T18:00:00Z'))
      const fiesta = await nuevoItem('Fiesta')
      await asignar.ejecutar(EVENTO, ceremonia.id, PLANIFICADOR, [EV_A])
      await nota.ejecutar(EVENTO, ceremonia.id, PLANIFICADOR, 'Llevar flores')
      await nota.ejecutar(EVENTO, ceremonia.id, PLANIFICADOR, 'Y velas')

      const delPlanner = await listar.ejecutar(EVENTO, true)
      const deLaPareja = await listar.ejecutar(EVENTO, false)

      expect(delPlanner.map((i) => [i.id, i.noteCount, i.vendors.length])).toEqual([
        [ceremonia.id, 2, 1],
        [fiesta.id, 0, 0],
      ])
      expect(deLaPareja.map((i) => [i.id, i.vendors.length])).toEqual([
        [ceremonia.id, 1],
        [fiesta.id, 0],
      ])
      for (const i of deLaPareja) expect(i).not.toHaveProperty('noteCount')
    })
  })

  describe('notas', () => {
    it('la pareja recibe SCHEDULE_ITEM_NOT_FOUND al leer y al escribir, sin crear nada', async () => {
      const { nuevoItem, notas, nota, repo } = escenario()
      const item = await nuevoItem()

      await expect(notas.ejecutar(EVENTO, item.id, false)).rejects.toMatchObject({
        code: 'SCHEDULE_ITEM_NOT_FOUND',
        httpStatus: 404,
      })
      await expect(nota.ejecutar(EVENTO, item.id, PAREJA, 'Hola')).rejects.toMatchObject({
        code: 'SCHEDULE_ITEM_NOT_FOUND',
        httpStatus: 404,
      })
      expect(repo.notas).toHaveLength(0)
    })

    it('un ítem de otro evento o inexistente es 404 también para el planner', async () => {
      const { notas, nota, repo } = escenario()
      const ajeno = await repo.crear({ ...base, eventId: OTRO, status: 'PENDING' })

      for (const id of [ajeno.id, NO_EXISTE]) {
        await expect(notas.ejecutar(EVENTO, id, true)).rejects.toMatchObject({
          code: 'SCHEDULE_ITEM_NOT_FOUND',
        })
        await expect(nota.ejecutar(EVENTO, id, PLANIFICADOR, 'Hola')).rejects.toMatchObject({
          code: 'SCHEDULE_ITEM_NOT_FOUND',
        })
      }
      expect(repo.notas).toHaveLength(0)
    })

    it('el planner escribe (recortada) y lee en orden cronológico', async () => {
      const { nuevoItem, notas, nota } = escenario()
      const item = await nuevoItem()

      const creada = await nota.ejecutar(EVENTO, item.id, PLANIFICADOR, '  Llevar flores  ')
      await nota.ejecutar(EVENTO, item.id, PLANIFICADOR, 'Y velas')

      expect(creada).toMatchObject({
        itemId: item.id,
        body: 'Llevar flores',
        author: { id: PLANNER_ID, name: 'Paula Planner', avatarKey: 'avatars/paula' },
      })
      expect((await notas.ejecutar(EVENTO, item.id, true)).map((n) => n.body)).toEqual([
        'Llevar flores',
        'Y velas',
      ])
    })

    it('vacía o de más de 2.000 caracteres → INVALID_NOTE', async () => {
      const { nuevoItem, nota, repo } = escenario()
      const item = await nuevoItem()

      for (const cuerpo of ['   ', 'a'.repeat(2001)]) {
        await expect(nota.ejecutar(EVENTO, item.id, PLANIFICADOR, cuerpo)).rejects.toMatchObject({
          code: 'INVALID_NOTE',
          httpStatus: 422,
        })
      }
      expect(repo.notas).toHaveLength(0)
    })
  })

  describe('confirmaciones', () => {
    it('estado: `mine` para el proveedor puro, para el miembro que además es proveedor y null para el resto', async () => {
      const { nuevoItem, asignar, confirmaciones } = escenario()
      const ceremonia = await nuevoItem('Ceremonia', new Date('2027-06-12T18:00:00Z'))
      await asignar.ejecutar(EVENTO, ceremonia.id, PLANIFICADOR, [EV_A])

      // Proveedor puro (acceso `vendor`) sin asignaciones vigentes, como tras cancelar: lista vacía.
      expect((await confirmaciones.estado(EVENTO, PROV_B, true)).mine).toEqual({ pending: [] })
      // Miembro con acceso `member` que además tiene asignaciones: ve sus pendientes.
      expect((await confirmaciones.estado(EVENTO, PROV_A, false)).mine).toEqual({
        pending: [
          { itemId: ceremonia.id, startsAt: new Date('2027-06-12T18:00:00Z'), endsAt: null },
        ],
      })
      // Miembro sin asignaciones: null.
      expect((await confirmaciones.estado(EVENTO, PLANNER_ID, false)).mine).toBeNull()
    })

    it('estado: X de Y por usuario, y `mine` sólo para el proveedor', async () => {
      const { nuevoItem, asignar, confirmaciones } = escenario()
      const ceremonia = await nuevoItem('Ceremonia', new Date('2027-06-12T18:00:00Z'))
      const fiesta = await nuevoItem('Fiesta')
      await asignar.ejecutar(EVENTO, ceremonia.id, PLANIFICADOR, [EV_A, EV_B])
      await asignar.ejecutar(EVENTO, fiesta.id, PLANIFICADOR, [EV_A2])

      const deLaPareja = await confirmaciones.estado(EVENTO, PLANNER_ID, false)
      expect(deLaPareja).toEqual({
        ready: 0,
        total: 2,
        vendors: [
          { userId: PROV_A, name: 'Ana Flores', avatarKey: null, ready: false },
          { userId: PROV_B, name: 'Bea Música', avatarKey: null, ready: false },
        ],
        mine: null,
      })

      const deA = await confirmaciones.estado(EVENTO, PROV_A, true)
      expect(deA.mine).toEqual({
        pending: [
          { itemId: ceremonia.id, startsAt: new Date('2027-06-12T18:00:00Z'), endsAt: null },
          { itemId: fiesta.id, startsAt: HORA, endsAt: null },
        ],
      })
    })

    it('confirmar confirma la unión de sus contrataciones y devuelve el estado nuevo', async () => {
      const { nuevoItem, asignar, confirmaciones, unidad } = escenario()
      const ceremonia = await nuevoItem('Ceremonia', new Date('2027-06-12T18:00:00Z'))
      const fiesta = await nuevoItem('Fiesta')
      await asignar.ejecutar(EVENTO, ceremonia.id, PLANIFICADOR, [EV_A, EV_B])
      await asignar.ejecutar(EVENTO, fiesta.id, PLANIFICADOR, [EV_A2])
      const vistos = (await confirmaciones.estado(EVENTO, PROV_A, true)).mine?.pending ?? []
      const antes = unidad.transacciones

      const despues = await confirmaciones.confirmar(EVENTO, PROV_A, vistos, true)

      expect(unidad.transacciones).toBe(antes + 1)
      expect(despues).toMatchObject({ ready: 1, total: 2, mine: { pending: [] } })
      expect(despues.vendors.map((v) => [v.userId, v.ready])).toEqual([
        [PROV_A, true],
        [PROV_B, false],
      ])
    })

    it('Review Focus 1: lo que cambió de hora entre mirar y confirmar queda pendiente', async () => {
      const { nuevoItem, asignar, editar, confirmaciones } = escenario()
      const item = await nuevoItem()
      await asignar.ejecutar(EVENTO, item.id, PLANIFICADOR, [EV_A])
      const vistos = (await confirmaciones.estado(EVENTO, PROV_A, true)).mine?.pending ?? []
      const nueva = new Date('2027-06-12T23:00:00Z')
      await editar.ejecutar(EVENTO, item.id, { startsAt: nueva }, PLANIFICADOR)

      const despues = await confirmaciones.confirmar(EVENTO, PROV_A, vistos, true)

      expect(despues.ready).toBe(0)
      expect(despues.mine).toEqual({
        pending: [{ itemId: item.id, startsAt: nueva, endsAt: null }],
      })
    })
  })

  describe('Notify Vendors', () => {
    it('sólo el planner: la pareja recibe 403', async () => {
      const { avisar } = escenario()

      await expect(avisar.ejecutar(EVENTO, PAREJA)).rejects.toMatchObject({
        code: 'SCHEDULE_PLANNER_ONLY',
      })
    })

    it('sin pendientes → { notified: 0 }, sin campana y sin job', async () => {
      const { nuevoItem, asignar, confirmaciones, avisar, avisos, cola } = escenario()
      const item = await nuevoItem()
      await asignar.ejecutar(EVENTO, item.id, PLANIFICADOR, [EV_A])
      await confirmaciones.confirmar(
        EVENTO,
        PROV_A,
        (await confirmaciones.estado(EVENTO, PROV_A, true)).mine?.pending ?? [],
        true,
      )
      cola.encolados.length = 0

      expect(await avisar.ejecutar(EVENTO, PLANIFICADOR)).toEqual({ notified: 0 })
      expect(avisos.creadas).toHaveLength(0)
      expect(cola.encolados).toHaveLength(0)
    })

    it('avisa una vez a cada proveedor con algo pendiente y empuja la campana', async () => {
      const { nuevoItem, asignar, avisar, avisos, cola } = escenario()
      const ceremonia = await nuevoItem('Ceremonia', new Date('2027-06-12T18:00:00Z'))
      const fiesta = await nuevoItem('Fiesta')
      await asignar.ejecutar(EVENTO, ceremonia.id, PLANIFICADOR, [EV_A, EV_B])
      await asignar.ejecutar(EVENTO, fiesta.id, PLANIFICADOR, [EV_A2])
      cola.encolados.length = 0

      expect(await avisar.ejecutar(EVENTO, PLANIFICADOR)).toEqual({ notified: 2 })
      expect(avisos.creadas).toEqual([
        { eventId: EVENTO, userId: PROV_A, tipo: 'schedule.confirmation.requested', payload: {} },
        { eventId: EVENTO, userId: PROV_B, tipo: 'schedule.confirmation.requested', payload: {} },
      ])
      expect(cola.encolados.map((j) => [j.nombre, j.datos])).toEqual([
        [
          'schedule.bell',
          { eventId: EVENTO, tipo: 'schedule.confirmation.requested', userIds: [PROV_A, PROV_B] },
        ],
      ])
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

    it('no tumba asignar ni Notify Vendors', async () => {
      const { nuevoItem, asignar, avisar, avisos } = escenario({ cola: new ColaRota() })
      const item = await nuevoItem()

      const asignado = await asignar.ejecutar(EVENTO, item.id, PLANIFICADOR, [EV_A])
      const resultado = await avisar.ejecutar(EVENTO, PLANIFICADOR)

      expect(asignado.vendors).toHaveLength(1)
      expect(resultado).toEqual({ notified: 1 })
      expect(avisos.creadas).toHaveLength(1)
      expect(aviso).toHaveBeenCalledTimes(2)
    })
  })
})
