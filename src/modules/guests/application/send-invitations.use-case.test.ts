import { Logger } from '@nestjs/common'

import type { QueuePort } from '@/modules/queue/application/queue.port'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import type { Guest, RsvpStatus } from '../domain/guest'
import { DIAS_DE_VALIDEZ } from '../domain/invitation'
import { GuestRepositoryEnMemoria } from '../infrastructure/guest.repository.fake'
import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { COLA_INVITACIONES, SendInvitationsUseCase } from './send-invitations.use-case'

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
    // El invitado también EXISTE para el repositorio de invitaciones: es la
    // fila a la que apunta su clave foránea, sin la cual `crear` da un 404.
    invitaciones.registrarInvitado({
      id: fila.id,
      eventId: fila.eventId,
      name: fila.name,
      email: fila.email,
    })
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
    //
    // HUECO CONOCIDO (ruling C16): el nombre del test es el del brief, pero a
    // este nivel el jobId no evita duplicados — cada llamada crea invitaciones
    // con ids nuevos, así que dos envíos masivos seguidos encolan dos jobs por
    // invitado. Lo único que protege de verdad es la guarda de estado del worker.
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

  it('un segundo envío caduca la invitación anterior: el invitado sólo tiene UN token vivo (C24)', async () => {
    sembrar('g1', 'a@test.com', 'PENDING')

    const primero = await caso.ejecutar('ev-1')
    const segundo = await caso.ejecutar('ev-1')

    const ahora = new Date()
    const vieja = invitaciones.buscar(primero.queued[0]?.invitationId ?? '')
    const nueva = invitaciones.buscar(segundo.queued[0]?.invitationId ?? '')
    expect(vieja?.expiresAt.getTime()).toBeLessThanOrEqual(ahora.getTime())
    expect(nueva?.expiresAt.getTime()).toBeGreaterThan(ahora.getTime())
  })

  it('un evento sin invitados devuelve listas vacías, no un error', async () => {
    expect(await caso.ejecutar('ev-vacio')).toEqual({ queued: [], skipped: [] })
  })

  it('encola con retención mínima: el token en claro no sobrevive al job en Redis', async () => {
    sembrar('g1', 'a@test.com', 'PENDING')

    await caso.ejecutar('ev-1')

    const opciones = cola.encolados[0]?.opciones
    expect(opciones?.removeOnComplete).toBe(true)
    expect(opciones?.removeOnFailAfterMs).toBeGreaterThan(0)
    // Y un fallido definitivo se borra MUCHO antes de que caduque el token.
    expect(opciones?.removeOnFailAfterMs ?? Infinity).toBeLessThan(DIAS_DE_VALIDEZ * 86_400_000)
  })

  it('un fallo en UN invitado no tumba el lote: se reporta y los demás siguen', async () => {
    sembrar('g1', 'a@test.com', 'PENDING')
    sembrar('g2', 'b@test.com', 'PENDING')
    sembrar('g3', 'c@test.com', 'PENDING')
    invitaciones.fallarCrearPara('g2', new Error('el invitado se borró a mitad'))

    const resultado = await caso.ejecutar('ev-1')

    expect(resultado.queued.map((q) => q.guestId)).toEqual(['g1', 'g3'])
    expect(resultado.skipped).toEqual([{ guestId: 'g2', reason: 'ENQUEUE_FAILED' }])
    expect(cola.encolados).toHaveLength(2)
  })

  it('encola en la cola PROPIA de invitaciones, no en la `email` compartida', async () => {
    sembrar('g1', 'a@test.com', 'PENDING')

    await caso.ejecutar('ev-1')

    expect(cola.encolados[0]?.cola).toBe(COLA_INVITACIONES)
    expect(cola.encolados[0]?.nombre).toBe('guest-invitation')
  })

  it('un fallo por invitado se REGISTRA con guestId y requestId, no se traga', async () => {
    const registro = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    sembrar('g1', 'a@test.com', 'PENDING')
    invitaciones.fallarCrearPara('g1', new Error('el invitado se borró a mitad'))

    await caso.ejecutar('ev-1', 'req-9')

    const lineas = registro.mock.calls.map((llamada) => JSON.stringify(llamada))
    expect(lineas.some((l) => l.includes('g1') && l.includes('req-9'))).toBe(true)
    registro.mockRestore()
  })

  it('el log del fallo NUNCA lleva el token en claro', async () => {
    const registro = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    let token = ''
    const colaCaida: QueuePort = {
      enqueue: (_cola, _nombre, datos) => {
        token = (datos as { token: string }).token
        return Promise.reject(new Error('Redis caído'))
      },
    }
    sembrar('g1', 'a@test.com', 'PENDING')

    const resultado = await new SendInvitationsUseCase(invitados, invitaciones, colaCaida).ejecutar(
      'ev-1',
      'req-9',
    )

    expect(resultado.skipped).toEqual([{ guestId: 'g1', reason: 'ENQUEUE_FAILED' }])
    expect(token).not.toBe('')
    expect(registro).toHaveBeenCalled()
    expect(JSON.stringify(registro.mock.calls)).not.toContain(token)
    registro.mockRestore()
  })
})
