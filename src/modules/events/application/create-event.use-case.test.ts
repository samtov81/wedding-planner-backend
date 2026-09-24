import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'
import { CreateEventUseCase } from './create-event.use-case'

describe('CreateEventUseCase', () => {
  it('crea un borrador solo con nombre y el creador es COUPLE', async () => {
    const repo = new EventRepositoryEnMemoria()
    const evento = await new CreateEventUseCase(repo).ejecutar({ name: 'Boda', ownerId: 'ana' })

    expect(evento).toMatchObject({ name: 'Boda', status: 'DRAFT', weddingDate: null })
    expect(await repo.buscarMembresiaActiva(evento.id, 'ana')).toEqual({ role: 'COUPLE' })
  })
})
