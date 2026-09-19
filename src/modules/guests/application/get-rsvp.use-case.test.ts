import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/in-memory-queue.adapter'
import type { DomainError } from '@/shared/domain'

import { InvitacionNoValidaError } from '../domain/guest-errors'
import { cierreRsvp, generarTokenInvitacion, type InvitationStatus } from '../domain/invitation'
import { GuestRepositoryEnMemoria } from '../infrastructure/guest.repository.fake'
import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { GetRsvpUseCase } from './get-rsvp.use-case'
import { SubmitRsvpUseCase, type RespuestaRsvp } from './submit-rsvp.use-case'

describe('GetRsvpUseCase', () => {
  let invitados: GuestRepositoryEnMemoria
  let invitaciones: InvitationRepositoryEnMemoria
  let caso: GetRsvpUseCase
  let secuencia = 0

  /**
   * El evento de todas las invitaciones del test. La boda es relativa a hoy:
   * el test que responde de verdad depende de `ahora < cierre`, y una fecha
   * fija lo rompería el día que el calendario pasara el cierre.
   */
  const evento = {
    id: 'ev-1',
    name: 'Boda de Ana',
    weddingDate: new Date(Date.now() + 180 * 86_400_000),
    rsvpDeadlineDays: 14,
  }

  /** Responde por el camino real (el caso de uso del POST) sobre los mismos dobles. */
  async function responder(token: string, respuesta: RespuestaRsvp): Promise<void> {
    await new SubmitRsvpUseCase(
      invitaciones,
      invitados,
      new NotificationPortEnMemoria(),
      new InMemoryQueueAdapter(),
      new UnidadDeTrabajoEnMemoria(),
    ).ejecutar(token, respuesta)
  }

  function prepararInvitacionValida(): Promise<{ token: string }> {
    return Promise.resolve({ token: prepararInvitacion() })
  }

  function prepararInvitacion(
    parcial: { expiresAt?: Date; status?: InvitationStatus; weddingDate?: Date } = {},
  ): string {
    secuencia += 1
    const { token, hash } = generarTokenInvitacion()
    invitaciones.añadir({
      id: `inv-${secuencia}`,
      tokenHash: hash,
      expiresAt: parcial.expiresAt ?? new Date(Date.now() + 86_400_000),
      status: parcial.status ?? 'DELIVERED',
      guest: { id: 'g1', eventId: 'ev-1', name: 'Ana Invitada', email: 'ana@test.com' },
      event: { ...evento, weddingDate: parcial.weddingDate ?? evento.weddingDate },
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
      weddingDate: evento.weddingDate.toISOString(),
      rsvp: 'PENDING',
      dietary: 'Vegan',
      rsvpClosesAt: new Date(evento.weddingDate.getTime() - 14 * 86_400_000).toISOString(),
    })
  })

  it('refleja el estado ACTUAL del invitado, no el de cuando se envió la invitación', async () => {
    const token = prepararInvitacion()
    await invitados.actualizar('ev-1', 'g1', { rsvp: 'CONFIRMED', dietary: null })

    const vista = await caso.ejecutar(token)

    expect(vista.rsvp).toBe('CONFIRMED')
    expect(vista.dietary).toBeNull()
  })

  it('con el token ya usado devuelve la respuesta actual y el cierre', async () => {
    const { token } = await prepararInvitacionValida()
    await responder(token, { rsvp: 'CONFIRMED', dietary: 'Vegan' })

    const vista = await caso.ejecutar(token)

    expect(vista.rsvp).toBe('CONFIRMED')
    expect(vista.dietary).toBe('Vegan')
    expect(vista.rsvpClosesAt).toBe(cierreRsvp(evento).toISOString())
  })

  it('pasado el cierre se sigue pudiendo leer mientras el token no caduque', async () => {
    const token = prepararInvitacion({
      status: 'RESPONDED',
      weddingDate: new Date(Date.now() + 3 * 86_400_000),
    })

    const vista = await caso.ejecutar(token)

    expect(vista.rsvp).toBe('PENDING')
    expect(Date.parse(vista.rsvpClosesAt)).toBeLessThan(Date.now())
  })

  it('devuelve el MISMO error para token inexistente, caducado y caducado por el worker', async () => {
    const caducado = prepararInvitacion({ expiresAt: new Date(Date.now() - 1000) })
    const porElWorker = prepararInvitacion({ status: 'RESPONDED' })
    await invitaciones.caducar(`inv-${secuencia}`)

    const errores = [
      await capturarError(() => caso.ejecutar('inventado')),
      await capturarError(() => caso.ejecutar(caducado)),
      await capturarError(() => caso.ejecutar(porElWorker)),
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
