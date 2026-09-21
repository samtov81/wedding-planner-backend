import { GuestRepositoryEnMemoria } from '../infrastructure/guest.repository.fake'
import { EVENTO_A } from '../infrastructure/guests.fixture'
import { CreateGuestUseCase } from './create-guest.use-case'

describe('CreateGuestUseCase', () => {
  it('crea un invitado sin email y lo deja en PENDING', async () => {
    const repo = new GuestRepositoryEnMemoria()
    const caso = new CreateGuestUseCase(repo)

    const invitado = await caso.ejecutar(EVENTO_A, {
      name: 'Tía Carmen',
      email: null,
      group: 'Family',
      dietary: null,
    })

    expect(invitado.email).toBeNull()
    expect(invitado.rsvp).toBe('PENDING')
  })
})
