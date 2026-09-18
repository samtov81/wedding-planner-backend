import type { DomainError } from '@/shared/domain'

import { InvitacionNoValidaError } from '../domain/guest-errors'
import { generarTokenInvitacion, type InvitationStatus } from '../domain/invitation'
import { GuestRepositoryEnMemoria } from '../infrastructure/guest.repository.fake'
import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { GetRsvpUseCase } from './get-rsvp.use-case'

describe('GetRsvpUseCase', () => {
  let invitados: GuestRepositoryEnMemoria
  let invitaciones: InvitationRepositoryEnMemoria
  let caso: GetRsvpUseCase
  let secuencia = 0

  function prepararInvitacion(
    parcial: { expiresAt?: Date; status?: InvitationStatus } = {},
  ): string {
    secuencia += 1
    const { token, hash } = generarTokenInvitacion()
    invitaciones.añadir({
      id: `inv-${secuencia}`,
      tokenHash: hash,
      expiresAt: parcial.expiresAt ?? new Date(Date.now() + 86_400_000),
      status: parcial.status ?? 'DELIVERED',
      guest: { id: 'g1', eventId: 'ev-1', name: 'Ana Invitada', email: 'ana@test.com' },
      event: { id: 'ev-1', name: 'Boda de Ana', weddingDate: new Date(Date.UTC(2027, 5, 12)) },
    })
    return token
  }

  async function capturarError(accion: () => Promise<unknown>): Promise<DomainError> {
    try {
      await accion()
    } catch (error) {
      return error as DomainError
    }
    throw new Error('se esperaba que la acción lanzara')
  }

  beforeEach(() => {
    secuencia = 0
    invitados = new GuestRepositoryEnMemoria()
    invitaciones = new InvitationRepositoryEnMemoria()
    invitados.sembrar({
      id: 'g1',
      eventId: 'ev-1',
      name: 'Ana Invitada',
      email: 'ana@test.com',
      group: 'Family',
      rsvp: 'PENDING',
      dietary: 'Vegan',
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    })
    caso = new GetRsvpUseCase(invitaciones, invitados)
  })

  it('devuelve EXACTAMENTE la vista pública: ni ids, ni correos, ni grupo', async () => {
    // `toEqual` sobre el objeto entero: cualquier campo de más rompe el test.
    // Quien tiene el token no está autenticado.
    const vista = await caso.ejecutar(prepararInvitacion())

    expect(vista).toEqual({
      guestName: 'Ana Invitada',
      eventName: 'Boda de Ana',
      weddingDate: '2027-06-12T00:00:00.000Z',
      rsvp: 'PENDING',
      dietary: 'Vegan',
    })
  })

  it('refleja el estado ACTUAL del invitado, no el de cuando se envió la invitación', async () => {
    const token = prepararInvitacion()
    await invitados.actualizar('ev-1', 'g1', { rsvp: 'CONFIRMED', dietary: null })

    const vista = await caso.ejecutar(token)

    expect(vista.rsvp).toBe('CONFIRMED')
    expect(vista.dietary).toBeNull()
  })

  it('devuelve el MISMO error para token inexistente, caducado y ya usado', async () => {
    const caducado = prepararInvitacion({ expiresAt: new Date(Date.now() - 1000) })
    const usado = prepararInvitacion({ status: 'RESPONDED' })

    const errores = [
      await capturarError(() => caso.ejecutar('inventado')),
      await capturarError(() => caso.ejecutar(caducado)),
      await capturarError(() => caso.ejecutar(usado)),
    ]

    for (const error of errores) {
      expect(error).toBeInstanceOf(InvitacionNoValidaError)
      expect(error.code).toBe('INVITATION_INVALID')
      expect(error.message).toBe(errores[0]?.message)
    }
  })

  it('el invitado borrado entre la búsqueda y la lectura es también una invitación no válida', async () => {
    // En Postgres la invitación cae en cascada con el invitado; el doble no la
    // borra, así que se prueba la rama defensiva del caso de uso.
    const token = prepararInvitacion()
    await invitados.borrar('ev-1', 'g1')

    await expect(caso.ejecutar(token)).rejects.toThrow(InvitacionNoValidaError)
  })
})
