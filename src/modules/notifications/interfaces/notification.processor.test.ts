import { randomUUID } from 'node:crypto'

import { UnrecoverableError, type Job } from 'bullmq'

import { BroadcastNoticeUseCase } from '../application/broadcast-notice.use-case'
import { NotificationRepositoryEnMemoria } from '../infrastructure/notification.repository.fake'
import { RealtimePortEnMemoria } from '../infrastructure/realtime.port.fake'
import { COLA_NOTIFICACIONES, NotificationProcessor } from './notification.processor'

/** Clave de metadata de `@Processor` (no exportada por `@nestjs/bullmq`). */
const PROCESSOR_METADATA = 'bullmq:processor_metadata'

describe('NotificationProcessor', () => {
  const eventId = randomUUID()
  const guestId = randomUUID()
  let realtime: RealtimePortEnMemoria
  let procesador: NotificationProcessor

  function job(name: string, data: unknown): Job {
    return { name, data, attemptsMade: 0, opts: { attempts: 5 } } as Job
  }

  beforeEach(() => {
    realtime = new RealtimePortEnMemoria()
    const repo = new NotificationRepositoryEnMemoria()
    repo.registrarMiembros(eventId, ['pareja'])
    procesador = new NotificationProcessor(new BroadcastNoticeUseCase(realtime, repo))
  })

  it('escucha la cola PROPIA del módulo, `notifications`', () => {
    expect(COLA_NOTIFICACIONES).toBe('notifications')
    expect(Reflect.getMetadata(PROCESSOR_METADATA, NotificationProcessor)).toMatchObject({
      name: 'notifications',
    })
  })

  describe('invitacion-de-miembro', () => {
    const userId = randomUUID()

    it.each(['nueva', 'cancelada'] as const)('emite %s al invitado y sólo a él', async (cambio) => {
      await procesador.process(job('invitacion-de-miembro', { userId, eventId, cambio }))

      expect(realtime.emitidas).toEqual([
        { destino: { userId }, tipo: 'member-invitation.changed', payload: { eventId, cambio } },
      ])
    })

    it('emite SÓLO lo validado: un campo de más en Redis no llega al socket', async () => {
      await procesador.process(
        job('invitacion-de-miembro', { userId, eventId, cambio: 'nueva', extra: 'x' }),
      )

      expect(realtime.emitidas[0]?.payload).toEqual({ eventId, cambio: 'nueva' })
    })

    it('un payload roto no se reintenta', async () => {
      await expect(
        procesador.process(job('invitacion-de-miembro', { userId, eventId, cambio: 'otra' })),
      ).rejects.toBeInstanceOf(UnrecoverableError)
      expect(realtime.emitidas).toEqual([])
    })
  })

  describe('event.member.responded', () => {
    const ownerId = randomUUID()

    it('event.member.responded avisa sólo al dueño en su sala personal', async () => {
      await procesador.process(job('event.member.responded', { eventId, ownerId }))

      // Nada a `event:<id>` (los planners no pueden abrir la vista) ni a los
      // miembros del evento: sólo `notification.created` al dueño.
      expect(realtime.emitidas).toEqual([
        {
          destino: { userId: ownerId },
          tipo: 'notification.created',
          payload: { eventId, type: 'event.member.responded' },
        },
      ])
    })

    it('emite SÓLO lo validado: un campo de más en Redis no llega al socket', async () => {
      await procesador.process(job('event.member.responded', { eventId, ownerId, extra: 'x' }))

      expect(realtime.emitidas[0]?.payload).toEqual({ eventId, type: 'event.member.responded' })
    })

    it('un job de respuesta con payload roto es irrecuperable', async () => {
      await expect(
        procesador.process(job('event.member.responded', { eventId, ownerId: 'no-es-guid' })),
      ).rejects.toBeInstanceOf(UnrecoverableError)
      expect(realtime.emitidas).toEqual([])
    })
  })

  describe('event.vendor.booked', () => {
    const userId = randomUUID()

    it('event.vendor.booked avisa sólo al proveedor en su sala personal', async () => {
      await procesador.process(job('event.vendor.booked', { eventId, userId }))

      // Nada a `event:<id>` (la pareja y los planners ya lo saben) ni a los
      // miembros: sólo `notification.created` al proveedor.
      expect(realtime.emitidas).toEqual([
        {
          destino: { userId },
          tipo: 'notification.created',
          payload: { eventId, type: 'event.vendor.booked' },
        },
      ])
    })

    it('un job de proveedor con payload roto es irrecuperable', async () => {
      await expect(
        procesador.process(job('event.vendor.booked', { eventId, userId: 'no-es-guid' })),
      ).rejects.toBeInstanceOf(UnrecoverableError)
      expect(realtime.emitidas).toEqual([])
    })
  })

  describe('guest.rsvp.updated', () => {
    const payload = { guestId, guestName: 'Ana', rsvp: 'CONFIRMED' }

    it('emite el cambio al evento y notification.created a cada destinatario', async () => {
      await procesador.process(job('guest.rsvp.updated', { eventId, payload }))

      expect(realtime.emitidas).toEqual([
        { destino: { eventId }, tipo: 'guest.rsvp.updated', payload },
        {
          destino: { userId: 'pareja' },
          tipo: 'notification.created',
          payload: { eventId, type: 'guest.rsvp.updated' },
        },
      ])
    })

    it('emite SÓLO lo validado: un campo de más en Redis no llega al socket', async () => {
      await procesador.process(
        job('guest.rsvp.updated', { eventId, payload: { ...payload, token: 'secreto' } }),
      )

      expect(realtime.emitidas[0]?.payload).toEqual(payload)
    })

    it.each([
      ['sin eventId', { payload }],
      ['eventId que no es UUID', { eventId: 'x', payload }],
      ['rsvp desconocido', { eventId, payload: { ...payload, rsvp: 'MAYBE' } }],
      ['sin payload', { eventId }],
    ])('un payload inválido (%s) falla SIN reintentos', async (_caso, datos) => {
      await expect(procesador.process(job('guest.rsvp.updated', datos))).rejects.toThrow(
        UnrecoverableError,
      )
      expect(realtime.emitidas).toEqual([])
    })

    it('si emitir falla, el error sale para que BullMQ reintente', async () => {
      realtime.fallarProximaEmision(new Error('redis caído'))

      await expect(
        procesador.process(job('guest.rsvp.updated', { eventId, payload })),
      ).rejects.toThrow('redis caído')
    })
  })

  describe('guest.invitation.status', () => {
    const payload = { guestId, invitationId: randomUUID(), status: 'BOUNCED' }

    it('un rebote avisa con notification.created a cada miembro', async () => {
      await procesador.process(job('guest.invitation.status', { eventId, payload }))

      expect(realtime.emitidas).toEqual([
        { destino: { eventId }, tipo: 'guest.invitation.status', payload },
        {
          destino: { userId: 'pareja' },
          tipo: 'notification.created',
          payload: { eventId, type: 'guest.invitation.status' },
        },
      ])
    })

    it('una entrega sólo avisa a la sala del evento', async () => {
      const entrega = { ...payload, status: 'DELIVERED' }
      await procesador.process(job('guest.invitation.status', { eventId, payload: entrega }))

      expect(realtime.emitidas).toEqual([
        { destino: { eventId }, tipo: 'guest.invitation.status', payload: entrega },
      ])
    })

    it('un estado desconocido falla sin reintentos', async () => {
      await expect(
        procesador.process(
          job('guest.invitation.status', { eventId, payload: { ...payload, status: 'OPENED' } }),
        ),
      ).rejects.toThrow(UnrecoverableError)
    })
  })

  it('un nombre de job desconocido FALLA a la vista, nunca se completa en silencio', async () => {
    // Retornar marcaría el job COMPLETADO y BullMQ lo borraría: un productor
    // nuevo perdería todos sus avisos sin que nadie lo viera.
    await expect(procesador.process(job('guest.deleted', { eventId }))).rejects.toThrow(
      UnrecoverableError,
    )
    await expect(procesador.process(job('guest.deleted', { eventId }))).rejects.toThrow(
      /guest\.deleted/,
    )
  })
})
