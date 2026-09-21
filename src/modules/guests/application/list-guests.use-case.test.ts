import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { decodeCursor } from '@/shared/domain'

import { GuestRepositoryEnMemoria } from '../infrastructure/guest.repository.fake'
import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { InvitadoNoEncontradoError } from '../domain/guest-errors'
import { CreateGuestUseCase } from './create-guest.use-case'
import { DeleteGuestUseCase } from './delete-guest.use-case'
import { ListGuestsUseCase } from './list-guests.use-case'
import { UpdateGuestUseCase } from './update-guest.use-case'

const EVENTO_A = '11111111-1111-4111-8111-111111111111'
const EVENTO_B = '22222222-2222-4222-8222-222222222222'

/** Ids con forma de UUID: `decodeCursor` los exige desde la Tarea 7. */
const A = (i: number): string => `aaaaaaaa-0000-4000-8000-00000000000${i}`
const B0 = 'bbbbbbbb-0000-4000-8000-000000000000'

function repoSembrado(): GuestRepositoryEnMemoria {
  const repo = new GuestRepositoryEnMemoria()
  const base = new Date('2026-01-01T00:00:00.000Z')

  for (let i = 0; i < 6; i += 1) {
    repo.sembrar({
      id: A(i),
      eventId: EVENTO_A,
      name: `G0${i}`,
      email: `g0${i}@boda.test`,
      group: i < 3 ? 'Family' : 'Friends',
      rsvp: i < 3 ? 'CONFIRMED' : 'PENDING',
      dietary: null,
      createdAt: new Date(base.getTime() + i * 1000),
    })
  }
  repo.sembrar({
    id: B0,
    eventId: EVENTO_B,
    name: 'De otra boda',
    email: null,
    group: 'Family',
    rsvp: 'CONFIRMED',
    dietary: null,
    createdAt: base,
  })

  return repo
}

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

  /** Una invitación vigente (caduca en 2027) de `a0`, como la que dejaría un envío. */
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
