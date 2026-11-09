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
const PLANIFICADOR = { puedeCambiarEstado: true }
const PAREJA = { puedeCambiarEstado: false }
const base = {
  title: 'Inicio de la fiesta',
  description: null,
  startsAt: new Date('2027-06-12T22:00:00Z'),
  endsAt: null,
  location: null,
}

describe('casos de uso del cronograma', () => {
  it('crea en PENDING por defecto y lista ordenado por hora', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const crear = new CreateScheduleItemUseCase(repo)
    await crear.ejecutar(EVENTO, { ...base, title: 'Fiesta' }, PLANIFICADOR)
    await crear.ejecutar(
      EVENTO,
      {
        ...base,
        title: 'Ceremonia',
        startsAt: new Date('2027-06-12T18:00:00Z'),
      },
      PLANIFICADOR,
    )

    const lista = await new ListScheduleItemsUseCase(repo).ejecutar(EVENTO)

    expect(lista.map((i) => [i.title, i.status])).toEqual([
      ['Ceremonia', 'PENDING'],
      ['Fiesta', 'PENDING'],
    ])
  })

  it('PATCH que deja el fin antes del inicio guardado → 422', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const item = await new CreateScheduleItemUseCase(repo).ejecutar(EVENTO, base, PLANIFICADOR)

    await expect(
      new UpdateScheduleItemUseCase(repo).ejecutar(
        EVENTO,
        item.id,
        {
          endsAt: new Date('2027-06-12T21:00:00Z'),
        },
        PLANIFICADOR,
      ),
    ).rejects.toBeInstanceOf(RangoDeCronogramaInvalidoError)
  })

  it('cambia el estado hasta DONE', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const item = await new CreateScheduleItemUseCase(repo).ejecutar(EVENTO, base, PLANIFICADOR)

    const hecho = await new UpdateScheduleItemUseCase(repo).ejecutar(
      EVENTO,
      item.id,
      {
        status: 'DONE',
      },
      PLANIFICADOR,
    )

    expect(hecho.status).toBe('DONE')
  })

  it('quien no puede cambiar el estado recibe 403 al mandar `status` en un PATCH', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const item = await new CreateScheduleItemUseCase(repo).ejecutar(EVENTO, base, PLANIFICADOR)

    await expect(
      new UpdateScheduleItemUseCase(repo).ejecutar(EVENTO, item.id, { status: 'DONE' }, PAREJA),
    ).rejects.toBeInstanceOf(CambioDeEstadoNoPermitidoError)
    expect((await repo.buscarPorId(EVENTO, item.id))?.status).toBe('PENDING')
  })

  it('quien no puede cambiar el estado sí edita el resto del ítem', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const item = await new CreateScheduleItemUseCase(repo).ejecutar(EVENTO, base, PAREJA)

    const editado = await new UpdateScheduleItemUseCase(repo).ejecutar(
      EVENTO,
      item.id,
      { title: 'Cena' },
      PAREJA,
    )

    expect(editado.title).toBe('Cena')
  })

  it('al crear, sólo quien puede cambiar el estado elige uno distinto de PENDING', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const crear = new CreateScheduleItemUseCase(repo)

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
    const repo = new ScheduleItemRepositoryEnMemoria()
    const item = await new CreateScheduleItemUseCase(repo).ejecutar(OTRO, base, PLANIFICADOR)

    await expect(
      new UpdateScheduleItemUseCase(repo).ejecutar(EVENTO, item.id, { title: 'X' }, PLANIFICADOR),
    ).rejects.toBeInstanceOf(ItemDeCronogramaNoEncontradoError)
    await expect(
      new DeleteScheduleItemUseCase(repo).ejecutar(EVENTO, item.id),
    ).rejects.toBeInstanceOf(ItemDeCronogramaNoEncontradoError)
  })
})
