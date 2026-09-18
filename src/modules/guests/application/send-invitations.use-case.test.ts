import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/in-memory-queue.adapter'

import type { Guest, RsvpStatus } from '../domain/guest'
import { GuestRepositoryEnMemoria } from '../infrastructure/guest.repository.fake'
import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { SendInvitationsUseCase } from './send-invitations.use-case'

describe('SendInvitationsUseCase', () => {
  let invitados: GuestRepositoryEnMemoria
  let invitaciones: InvitationRepositoryEnMemoria
  let cola: InMemoryQueueAdapter
  let caso: SendInvitationsUseCase

  /**
   * El brief escribe `invitados.añadir({ id, eventId, email, rsvp })`. El doble
   * de la Tarea 11 siembra filas COMPLETAS (`sembrar`), justo para que un
   * invitado del test no pueda tener menos campos que uno real; este ayudante
   * rellena el resto sin inventar un segundo método más permisivo en el doble.
   */
  function sembrar(id: string, email: string | null, rsvp: RsvpStatus, eventId = 'ev-1'): void {
    const fila: Guest = {
      id,
      eventId,
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
    caso = new SendInvitationsUseCase(invitados, invitaciones, cola)
  })

  it('encola una invitación por cada invitado con email', async () => {
    sembrar('g1', 'a@test.com', 'PENDING')
    sembrar('g2', 'b@test.com', 'PENDING')

    const resultado = await caso.ejecutar('ev-1')

    expect(resultado.queued).toHaveLength(2)
    expect(resultado.skipped).toHaveLength(0)
    expect(cola.encolados).toHaveLength(2)
  })

  it('REPORTA los invitados sin email como omitidos, no los descarta en silencio', async () => {
    sembrar('g1', 'a@test.com', 'PENDING')
    sembrar('g2', null, 'PENDING')

    const resultado = await caso.ejecutar('ev-1')

    expect(resultado.queued.map((q) => q.guestId)).toEqual(['g1'])
    expect(resultado.skipped).toEqual([{ guestId: 'g2', reason: 'NO_EMAIL' }])
  })

  it('omite a quien ya respondió: reinvitarle es ruido', async () => {
    sembrar('g1', 'a@test.com', 'CONFIRMED')

    const resultado = await caso.ejecutar('ev-1')

    expect(resultado.skipped).toEqual([{ guestId: 'g1', reason: 'ALREADY_RESPONDED' }])
    expect(cola.encolados).toHaveLength(0)
  })

  it('usa un jobId derivado de la invitación, para que reintentar no duplique', async () => {
    sembrar('g1', 'a@test.com', 'PENDING')

    const resultado = await caso.ejecutar('ev-1')

    // Separador `-` y no `:`: BullMQ rechaza un jobId con dos puntos, que es su
    // separador de claves de Redis ("Custom Id cannot contain :").
    expect(cola.encolados[0]?.jobId).toBe(`invitation-${resultado.queued[0]?.invitationId ?? ''}`)
  })

  it('manda el token en claro en el payload del job, nunca a la base de datos', async () => {
    sembrar('g1', 'a@test.com', 'PENDING')

    const resultado = await caso.ejecutar('ev-1')

    const payload = cola.encolados[0]?.datos as {
      invitationId: string
      token: string
      requestId: string
    }
    expect(payload.invitationId).toBe(resultado.queued[0]?.invitationId)
    expect(payload.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(payload.requestId).toBe('')
  })

  it('guarda sólo el HASH del token, nunca el token', async () => {
    sembrar('g1', 'a@test.com', 'PENDING')

    await caso.ejecutar('ev-1')

    const guardada = invitaciones.todas()[0]
    const token = (cola.encolados[0]?.datos as { token: string }).token
    expect(guardada?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(guardada?.tokenHash).not.toBe(token)
    expect(JSON.stringify(guardada)).not.toContain(token)
  })

  it('no toca a los invitados de otro evento', async () => {
    sembrar('g1', 'a@test.com', 'PENDING')
    sembrar('ajeno', 'otro@test.com', 'PENDING', 'ev-2')

    const resultado = await caso.ejecutar('ev-1')

    expect(resultado.queued.map((q) => q.guestId)).toEqual(['g1'])
    expect(invitaciones.todas()).toHaveLength(1)
  })

  it('un evento sin invitados devuelve listas vacías, no un error', async () => {
    expect(await caso.ejecutar('ev-vacio')).toEqual({ queued: [], skipped: [] })
  })
})
