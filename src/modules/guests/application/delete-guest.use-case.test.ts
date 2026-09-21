import { InvitadoNoEncontradoError } from '../domain/guest-errors'
import { A, B0, EVENTO_A, EVENTO_B, repoSembrado } from '../infrastructure/guests.fixture'
import { DeleteGuestUseCase } from './delete-guest.use-case'

describe('DeleteGuestUseCase', () => {
  it('borra un invitado del evento', async () => {
    const repo = repoSembrado()
    const caso = new DeleteGuestUseCase(repo)

    await caso.ejecutar(EVENTO_A, A(0))

    expect(await repo.buscar(EVENTO_A, A(0))).toBeNull()
  })

  it('borrar un invitado de otro evento es 404, no un borrado silencioso', async () => {
    const repo = repoSembrado()
    const caso = new DeleteGuestUseCase(repo)

    await expect(caso.ejecutar(EVENTO_A, B0)).rejects.toBeInstanceOf(InvitadoNoEncontradoError)
    expect(await repo.buscar(EVENTO_B, B0)).not.toBeNull()
  })
})
