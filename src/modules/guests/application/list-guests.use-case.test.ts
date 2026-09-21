import { decodeCursor } from '@/shared/domain'

import { EVENTO_A, repoSembrado } from '../infrastructure/guests.fixture'
import { ListGuestsUseCase } from './list-guests.use-case'

describe('ListGuestsUseCase', () => {
  it('pagina con cursor y acaba con nextCursor null', async () => {
    const repo = repoSembrado()
    const caso = new ListGuestsUseCase(repo)

    const primera = await caso.ejecutar(EVENTO_A, {}, null, 4)
    expect(primera.items.map((g) => g.name)).toEqual(['G00', 'G01', 'G02', 'G03'])
    expect(primera.nextCursor).not.toBeNull()

    const segunda = await caso.ejecutar(EVENTO_A, {}, decodeCursor(primera.nextCursor ?? ''), 4)
    expect(segunda.items.map((g) => g.name)).toEqual(['G04', 'G05'])
    expect(segunda.nextCursor).toBeNull()
  })

  it('nunca devuelve invitados de otro evento', async () => {
    const repo = repoSembrado()
    const caso = new ListGuestsUseCase(repo)

    const pagina = await caso.ejecutar(EVENTO_A, {}, null, 50)

    expect(pagina.items.every((g) => g.eventId === EVENTO_A)).toBe(true)
    expect(pagina.items.map((g) => g.name)).not.toContain('De otra boda')
  })

  it('combina filtros de estado y grupo', async () => {
    const repo = repoSembrado()
    const caso = new ListGuestsUseCase(repo)

    const pagina = await caso.ejecutar(EVENTO_A, { rsvp: 'CONFIRMED', group: 'Family' }, null, 50)

    expect(pagina.items.map((g) => g.name)).toEqual(['G00', 'G01', 'G02'])
  })
})
