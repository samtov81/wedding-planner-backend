import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/in-memory-queue.adapter'

import type { Guest, RsvpStatus } from '../domain/guest'
import { GuestHasNoEmailError, InvitadoNoEncontradoError } from '../domain/guest-errors'
import { GuestRepositoryEnMemoria } from '../infrastructure/guest.repository.fake'
import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { SendSingleInvitationUseCase } from './send-single-invitation.use-case'

describe('SendSingleInvitationUseCase', () => {
  let invitados: GuestRepositoryEnMemoria
  let invitaciones: InvitationRepositoryEnMemoria
  let cola: InMemoryQueueAdapter
  let caso: SendSingleInvitationUseCase

  function sembrar(id: string, email: string | null, rsvp: RsvpStatus = 'PENDING'): void {
    const fila: Guest = {
      id,
      eventId: 'ev-1',
      name: `Invitado ${id}`,
      email,
      group: 'Family',
      rsvp,
      dietary: null,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, invitados.filas.length)),
    }
    invitados.sembrar(fila)
  }

  beforeEach(() => {
    invitados = new GuestRepositoryEnMemoria()
    invitaciones = new InvitationRepositoryEnMemoria()
    cola = new InMemoryQueueAdapter()
    caso = new SendSingleInvitationUseCase(invitados, invitaciones, cola)
  })

  it('encola la invitación de un invitado con correo', async () => {
    sembrar('g1', 'a@test.com')

    const resultado = await caso.ejecutar('ev-1', 'g1', 'req-7')

    expect(resultado.guestId).toBe('g1')
    expect(cola.encolados).toHaveLength(1)
    expect(cola.encolados[0]?.jobId).toBe(`invitation-${resultado.invitationId}`)
    expect((cola.encolados[0]?.datos as { requestId: string }).requestId).toBe('req-7')
  })

  it('un invitado SIN correo es 422, no un 202 silencioso', async () => {
    sembrar('g1', null)

    await expect(caso.ejecutar('ev-1', 'g1')).rejects.toBeInstanceOf(GuestHasNoEmailError)
    expect(cola.encolados).toHaveLength(0)
    expect(invitaciones.todas()).toHaveLength(0)
  })

  it('un invitado de OTRO evento es 404, no se le invita a esta boda', async () => {
    sembrar('g1', 'a@test.com')

    await expect(caso.ejecutar('ev-2', 'g1')).rejects.toBeInstanceOf(InvitadoNoEncontradoError)
    expect(cola.encolados).toHaveLength(0)
  })

  it('reenviar ("se perdió el correo") caduca el enlace anterior (C24)', async () => {
    sembrar('g1', 'a@test.com')

    const primero = await caso.ejecutar('ev-1', 'g1')
    const segundo = await caso.ejecutar('ev-1', 'g1')

    const ahora = Date.now()
    expect(invitaciones.buscar(primero.invitationId)?.expiresAt.getTime()).toBeLessThanOrEqual(
      ahora,
    )
    expect(invitaciones.buscar(segundo.invitationId)?.expiresAt.getTime()).toBeGreaterThan(ahora)
  })

  it('reenviar a quien ya respondió SÍ se permite: es un acto deliberado', async () => {
    sembrar('g1', 'a@test.com', 'CONFIRMED')

    await caso.ejecutar('ev-1', 'g1')

    expect(cola.encolados).toHaveLength(1)
  })
})
