import { Logger } from '@nestjs/common'

import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { HandleDeliveryEventUseCase, mapearEstadoResend } from './handle-delivery-event.use-case'

/**
 * El caso de uso registra lo que descarta (`debug`) y los avisos que no puede
 * encolar (`warn`). En test ese ruido tapa el resultado, así que se silencia
 * para todo el fichero; los tests que lo comprueban montan su propio espía.
 */
beforeEach(() => {
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HandleDeliveryEventUseCase', () => {
  let invitaciones: InvitationRepositoryEnMemoria
  let cola: InMemoryQueueAdapter
  let caso: HandleDeliveryEventUseCase

  beforeEach(() => {
    invitaciones = new InvitationRepositoryEnMemoria()
    cola = new InMemoryQueueAdapter()
    caso = new HandleDeliveryEventUseCase(invitaciones, cola)
  })

  it('marca DELIVERED cuando el correo se entrega', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'SENT' })

    await caso.ejecutar({ type: 'email.delivered', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('DELIVERED')
  })

  it('marca BOUNCED cuando rebota', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'SENT' })

    await caso.ejecutar({ type: 'email.bounced', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('BOUNCED')
  })

  it('es idempotente: el mismo evento dos veces no cambia nada', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'SENT' })

    await caso.ejecutar({ type: 'email.delivered', messageId: 'msg-1' })
    await caso.ejecutar({ type: 'email.delivered', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('DELIVERED')
  })

  it('NO retrocede el estado: un delivered tardío no pisa un RESPONDED', async () => {
    // Los webhooks llegan desordenados. Si `delivered` sobrescribe sin mirar,
    // un invitado que ya respondió vuelve a aparecer como pendiente.
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'RESPONDED' })

    await caso.ejecutar({ type: 'email.delivered', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('RESPONDED')
  })

  it('NO retrocede el estado: un delivered tardío no pisa un BOUNCED', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'SENT' })

    await caso.ejecutar({ type: 'email.bounced', messageId: 'msg-1' })
    await caso.ejecutar({ type: 'email.delivered', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('BOUNCED')
  })

  it('un complained no pisa un BOUNCED ya registrado (mismo rango, no avanza)', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'BOUNCED' })

    await caso.ejecutar({ type: 'email.complained', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('BOUNCED')
  })

  it('un complained tras un delivered sí avanza', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'DELIVERED' })

    await caso.ejecutar({ type: 'email.complained', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('COMPLAINED')
  })

  it('ignora un messageId desconocido sin lanzar', async () => {
    // Devolver 500 hace que Resend reintente indefinidamente un evento que
    // nunca vamos a poder casar.
    await expect(
      caso.ejecutar({ type: 'email.delivered', messageId: 'ajeno' }),
    ).resolves.toBeUndefined()
  })

  it('deja rastro (debug) del messageId que no casa con ninguna invitación', async () => {
    // Ignorarlo es correcto, pero en silencio no se distingue de un webhook que
    // sí debería haber avanzado algo: sin este rastro no hay nada que mirar.
    const depuracion = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined)

    await caso.ejecutar({ type: 'email.delivered', messageId: 'ajeno' })

    const registrado = depuracion.mock.calls.map((llamada) => String(llamada[0])).join('\n')
    expect(registrado).toContain('messageId=ajeno')
    depuracion.mockRestore()
  })

  it('ignora tipos de evento que no nos interesan', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'SENT' })

    await caso.ejecutar({ type: 'email.opened', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('SENT')
  })

  it('sólo toca la invitación de ESE messageId', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'SENT' })
    invitaciones.añadir({ id: 'inv-2', resendMessageId: 'msg-2', status: 'SENT' })

    await caso.ejecutar({ type: 'email.bounced', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-2')?.status).toBe('SENT')
  })
})

describe('HandleDeliveryEventUseCase — aviso en tiempo real (guest.invitation.status)', () => {
  let invitaciones: InvitationRepositoryEnMemoria
  let cola: InMemoryQueueAdapter
  let caso: HandleDeliveryEventUseCase

  beforeEach(() => {
    invitaciones = new InvitationRepositoryEnMemoria()
    cola = new InMemoryQueueAdapter()
    caso = new HandleDeliveryEventUseCase(invitaciones, cola)
    invitaciones.añadir({
      id: 'inv-1',
      resendMessageId: 'msg-1',
      status: 'SENT',
      guest: { id: 'g-1', eventId: 'ev-1' },
    })
  })

  it('un estado que AVANZA encola el aviso en `notifications`, con jobId determinista', async () => {
    await caso.ejecutar({ type: 'email.bounced', messageId: 'msg-1' })

    expect(cola.encolados).toEqual([
      {
        cola: 'notifications',
        nombre: 'guest.invitation.status',
        datos: {
          eventId: 'ev-1',
          payload: { guestId: 'g-1', invitationId: 'inv-1', status: 'BOUNCED' },
        },
        jobId: 'invitation-status-inv-1-BOUNCED',
        opciones: { jobId: 'invitation-status-inv-1-BOUNCED' },
      },
    ])
  })

  it('un webhook que no avanza nada (repetido, tardío o ajeno) no encola nada', async () => {
    await caso.ejecutar({ type: 'email.delivered', messageId: 'msg-1' })
    await caso.ejecutar({ type: 'email.delivered', messageId: 'msg-1' })
    await caso.ejecutar({ type: 'email.opened', messageId: 'msg-1' })
    await caso.ejecutar({ type: 'email.delivered', messageId: 'ajeno' })

    expect(cola.encolados.map((e) => e.jobId)).toEqual(['invitation-status-inv-1-DELIVERED'])
  })

  it('si encolar falla, el estado ya está escrito y el webhook no falla', async () => {
    // Fallar haría que Resend reintentara; el reintento ya no avanza nada (el
    // estado está escrito), así que tampoco encolaría: fallar no recupera el aviso.
    vi.spyOn(cola, 'enqueue').mockRejectedValueOnce(new Error('redis caído'))

    await expect(
      caso.ejecutar({ type: 'email.bounced', messageId: 'msg-1' }),
    ).resolves.toBeUndefined()

    expect(invitaciones.buscar('inv-1')?.status).toBe('BOUNCED')
  })
})

describe('mapearEstadoResend', () => {
  it.each([
    ['email.delivered', 'DELIVERED'],
    ['email.bounced', 'BOUNCED'],
    ['email.complained', 'COMPLAINED'],
    ['email.sent', null],
    ['email.opened', null],
    ['email.clicked', null],
    ['contact.created', null],
  ] as const)('%s → %s', (type, esperado) => {
    expect(mapearEstadoResend(type)).toBe(esperado)
  })
})
