import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'

import { InvitadoNoEncontradoError } from '../domain/guest-errors'
import type { GuestRepositoryEnMemoria } from '../infrastructure/guest.repository.fake'
import { A, B0, EVENTO_A, repoSembrado } from '../infrastructure/guests.fixture'
import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { UpdateGuestUseCase } from './update-guest.use-case'

describe('UpdateGuestUseCase', () => {
  let invitaciones: InvitationRepositoryEnMemoria
  let unidad: UnidadDeTrabajoEnMemoria

  beforeEach(() => {
    invitaciones = new InvitationRepositoryEnMemoria()
    unidad = new UnidadDeTrabajoEnMemoria()
  })

  function casoCon(repo: GuestRepositoryEnMemoria): UpdateGuestUseCase {
    return new UpdateGuestUseCase(repo, invitaciones, unidad)
  }

  /** Una invitación vigente (caduca en 2099) de `a0`, como la que dejaría un envío. */
  function invitacionVigenteDeA0(): string {
    return invitaciones.añadir({
      id: 'inv-a0',
      status: 'DELIVERED',
      expiresAt: new Date(Date.UTC(2099, 0, 1)),
      guest: { id: A(0), eventId: EVENTO_A },
    }).id
  }

  it('actualiza el RSVP de un invitado del evento', async () => {
    const repo = repoSembrado()
    const caso = casoCon(repo)

    const actualizado = await caso.ejecutar(EVENTO_A, A(0), { rsvp: 'DECLINED' })

    expect(actualizado.rsvp).toBe('DECLINED')
  })

  it('un invitado de OTRO evento se comporta como inexistente', async () => {
    const repo = repoSembrado()
    const caso = casoCon(repo)

    await expect(caso.ejecutar(EVENTO_A, B0, { rsvp: 'DECLINED' })).rejects.toBeInstanceOf(
      InvitadoNoEncontradoError,
    )
  })

  describe('cambiar el email caduca los tokens vigentes (ruling C24)', () => {
    it.each([
      ['a otra dirección', 'corregido@boda.test'],
      ['a ninguna', null],
    ])(
      'al cambiarlo %s, el enlace enviado a la dirección vieja deja de servir',
      async (_c, email) => {
        const id = invitacionVigenteDeA0()

        await casoCon(repoSembrado()).ejecutar(EVENTO_A, A(0), { email })

        expect(invitaciones.buscar(id)?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now())
        // Cambio de email y caducidad en la MISMA unidad de trabajo.
        expect(unidad.transacciones).toBe(1)
      },
    )

    it('un PATCH que no cambia el email (o repite el mismo) no toca las invitaciones', async () => {
      const id = invitacionVigenteDeA0()
      const caso = casoCon(repoSembrado())

      await caso.ejecutar(EVENTO_A, A(0), { rsvp: 'DECLINED', name: 'Otro nombre' })
      await caso.ejecutar(EVENTO_A, A(0), { email: 'g00@boda.test' })

      expect(invitaciones.buscar(id)?.expiresAt).toEqual(new Date(Date.UTC(2099, 0, 1)))
    })
  })
})
