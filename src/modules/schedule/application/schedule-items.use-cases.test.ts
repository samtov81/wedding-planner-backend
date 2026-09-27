import {
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
    await crear.ejecutar(EVENTO, { ...base, title: 'Fiesta' })
    await crear.ejecutar(EVENTO, {
      ...base,
      title: 'Ceremonia',
      startsAt: new Date('2027-06-12T18:00:00Z'),
    })

    const lista = await new ListScheduleItemsUseCase(repo).ejecutar(EVENTO)

    expect(lista.map((i) => [i.title, i.status])).toEqual([
      ['Ceremonia', 'PENDING'],
      ['Fiesta', 'PENDING'],
    ])
  })

  it('PATCH que deja el fin antes del inicio guardado → 422', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const item = await new CreateScheduleItemUseCase(repo).ejecutar(EVENTO, base)

    await expect(
      new UpdateScheduleItemUseCase(repo).ejecutar(EVENTO, item.id, {
        endsAt: new Date('2027-06-12T21:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(RangoDeCronogramaInvalidoError)
  })

  it('cambia el estado hasta DONE', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const item = await new CreateScheduleItemUseCase(repo).ejecutar(EVENTO, base)

    const hecho = await new UpdateScheduleItemUseCase(repo).ejecutar(EVENTO, item.id, {
      status: 'DONE',
    })

    expect(hecho.status).toBe('DONE')
  })

  it('un ítem de otro evento es 404 al editar y al borrar', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const item = await new CreateScheduleItemUseCase(repo).ejecutar(OTRO, base)

    await expect(
      new UpdateScheduleItemUseCase(repo).ejecutar(EVENTO, item.id, { title: 'X' }),
    ).rejects.toBeInstanceOf(ItemDeCronogramaNoEncontradoError)
    await expect(
      new DeleteScheduleItemUseCase(repo).ejecutar(EVENTO, item.id),
    ).rejects.toBeInstanceOf(ItemDeCronogramaNoEncontradoError)
  })
})
