import { EventoIncompletoError, EventoNoEncontradoError } from '../domain/event-errors'
import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'
import { UpdateEventUseCase } from './update-event.use-case'

const VENUE = { name: null, address: 'Calle 1', lat: 4.6, lng: -74.1, mapboxId: null }

function eventoActivo(repo: EventRepositoryEnMemoria, extra: object = {}): string {
  const id = '11111111-1111-4111-8111-111111111111'
  repo.eventos.push({
    id,
    ownerId: 'ana',
    status: 'ACTIVE',
    name: 'Boda',
    weddingDate: new Date('2027-06-12T00:00:00Z'),
    currency: 'USD',
    totalBudget: '100.00',
    venue: VENUE,
    ...extra,
  })
  return id
}

describe('UpdateEventUseCase', () => {
  it('en un borrador acepta dejar campos vacíos', async () => {
    const repo = new EventRepositoryEnMemoria()
    const creado = await repo.crearConMembresia({
      name: 'Boda',
      ownerId: 'ana',
      totalBudget: '10.00',
    })
    const caso = new UpdateEventUseCase(repo)

    const evento = await caso.ejecutar(creado.id, { totalBudget: null, weddingDate: null })

    expect(evento).toMatchObject({ status: 'DRAFT', totalBudget: null, weddingDate: null })
  })

  it('en un ACTIVE permite cambiarlo todo, moneda incluida', async () => {
    const repo = new EventRepositoryEnMemoria()
    const id = eventoActivo(repo)
    const caso = new UpdateEventUseCase(repo)

    const evento = await caso.ejecutar(id, {
      name: 'Boda de Ana',
      currency: 'COP',
      totalBudget: '4500000.00',
      venue: { ...VENUE, address: 'Calle 2' },
    })

    expect(evento).toMatchObject({
      name: 'Boda de Ana',
      currency: 'COP',
      totalBudget: '4500000.00',
    })
  })

  it('en un ACTIVE rechaza vaciar el venue con 422 y no persiste nada', async () => {
    const repo = new EventRepositoryEnMemoria()
    const id = eventoActivo(repo)
    const caso = new UpdateEventUseCase(repo)

    const error = await caso.ejecutar(id, { venue: null, name: 'Otro' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EventoIncompletoError)
    expect((error as EventoIncompletoError).details).toEqual({ faltantes: ['venue'] })
    expect((await repo.buscarPorId(id))?.name).toBe('Boda')
  })

  it('en un ACTIVE que ya venía sin venue (migrado) deja editar otros campos', async () => {
    const repo = new EventRepositoryEnMemoria()
    const id = eventoActivo(repo, { venue: null })
    const caso = new UpdateEventUseCase(repo)

    await expect(caso.ejecutar(id, { name: 'Nuevo' })).resolves.toMatchObject({ name: 'Nuevo' })
  })

  it('evento inexistente → 404', async () => {
    const caso = new UpdateEventUseCase(new EventRepositoryEnMemoria())
    await expect(
      caso.ejecutar('00000000-0000-4000-8000-000000000000', { name: 'X' }),
    ).rejects.toBeInstanceOf(EventoNoEncontradoError)
  })
})
