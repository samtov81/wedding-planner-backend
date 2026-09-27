import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'

import { AcompanantesExcedidosError, InvitadoNoEncontradoError } from '../domain/guest-errors'
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

  describe('cupo de acompañantes', () => {
    function repoConConfirmados(confirmados: number | null): GuestRepositoryEnMemoria {
      const repo = repoSembrado()
      const fila = repo.filas.find((g) => g.id === A(0))
      if (fila !== undefined) {
        fila.companionsAllowed = 3
        fila.companionsConfirmed = confirmados
      }
      return repo
    }

    it('se puede subir o bajar mientras cubra lo ya confirmado', async () => {
      const caso = casoCon(repoConConfirmados(2))

      expect(
        (await caso.ejecutar(EVENTO_A, A(0), { companionsAllowed: 5 })).companionsAllowed,
      ).toBe(5)
      expect(
        (await caso.ejecutar(EVENTO_A, A(0), { companionsAllowed: 2 })).companionsAllowed,
      ).toBe(2)
    })

    it('bajarlo por debajo de lo confirmado → 422 COMPANIONS_EXCEEDED sin escribir', async () => {
      const repo = repoConConfirmados(2)

      await expect(
        casoCon(repo).ejecutar(EVENTO_A, A(0), { companionsAllowed: 1 }),
      ).rejects.toBeInstanceOf(AcompanantesExcedidosError)
      expect(repo.filas.find((g) => g.id === A(0))?.companionsAllowed).toBe(3)
    })

    it('sin respuesta todavía (null) se puede dejar en 0', async () => {
      const caso = casoCon(repoConConfirmados(null))

      expect(
        (await caso.ejecutar(EVENTO_A, A(0), { companionsAllowed: 0 })).companionsAllowed,
      ).toBe(0)
    })
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
