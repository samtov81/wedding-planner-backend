import { EventoIncompletoError } from '../domain/event-errors'
import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'
import { PublishEventUseCase } from './publish-event.use-case'

const VENUE = { name: null, address: 'Calle 1', lat: 4.6, lng: -74.1, mapboxId: null }

describe('PublishEventUseCase', () => {
  it('rechaza un borrador incompleto con la lista de faltantes', async () => {
    const repo = new EventRepositoryEnMemoria()
    const creado = await repo.crearConMembresia({ name: 'Boda', ownerId: 'ana' })

    const error = await new PublishEventUseCase(repo).ejecutar(creado.id).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EventoIncompletoError)
    expect((error as EventoIncompletoError).details).toEqual({
      faltantes: ['weddingDate', 'totalBudget', 'venue'],
    })
    expect((await repo.buscarPorId(creado.id))?.status).toBe('DRAFT')
  })

  it('publica un borrador completo', async () => {
    const repo = new EventRepositoryEnMemoria()
    const creado = await repo.crearConMembresia({
      name: 'Boda',
      ownerId: 'ana',
      weddingDate: new Date('2027-06-12T00:00:00Z'),
      totalBudget: '0.00',
      venue: VENUE,
    })

    const evento = await new PublishEventUseCase(repo).ejecutar(creado.id)

    expect(evento.status).toBe('ACTIVE')
  })

  it('un PATCH concurrente que vacía el venue entre el check y la escritura no deja un ACTIVE a medias', async () => {
    // Simula la ventana entre "ya comprobé que está completo" y "ya escribí
    // ACTIVE": justo antes de que `publicarSiCompleto` escriba, otra petición
    // vacía el venue. La escritura condicional no debe aplicarse, y el caso
    // de uso tiene que releer y reportar el faltante real, no dejar el evento
    // ACTIVE sin venue.
    const repo = new EventRepositoryEnMemoria()
    const creado = await repo.crearConMembresia({
      name: 'Boda',
      ownerId: 'ana',
      weddingDate: new Date('2027-06-12T00:00:00Z'),
      totalBudget: '100.00',
      venue: VENUE,
    })
    const original = repo.publicarSiCompleto.bind(repo)
    vi.spyOn(repo, 'publicarSiCompleto').mockImplementationOnce(async (id: string) => {
      await repo.actualizar(id, { venue: null })
      return await original(id)
    })

    const error = await new PublishEventUseCase(repo).ejecutar(creado.id).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EventoIncompletoError)
    expect((error as EventoIncompletoError).details).toEqual({ faltantes: ['venue'] })
    expect((await repo.buscarPorId(creado.id))?.status).toBe('DRAFT')
  })

  it('publicar un ACTIVE es idempotente', async () => {
    const repo = new EventRepositoryEnMemoria()
    repo.eventos.push({
      id: '11111111-1111-4111-8111-111111111111',
      ownerId: 'ana',
      status: 'ACTIVE',
    })

    const evento = await new PublishEventUseCase(repo).ejecutar(
      '11111111-1111-4111-8111-111111111111',
    )

    expect(evento.status).toBe('ACTIVE')
  })
})
