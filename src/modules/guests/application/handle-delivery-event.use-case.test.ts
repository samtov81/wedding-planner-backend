import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { HandleDeliveryEventUseCase, mapearEstadoResend } from './handle-delivery-event.use-case'

describe('HandleDeliveryEventUseCase', () => {
  let invitaciones: InvitationRepositoryEnMemoria
  let caso: HandleDeliveryEventUseCase

  beforeEach(() => {
    invitaciones = new InvitationRepositoryEnMemoria()
    caso = new HandleDeliveryEventUseCase(invitaciones)
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
