import { decodeCursor } from '@/shared/domain'

import { NotificacionNoEncontradaError } from '../domain/notification-errors'
import { NotificationRepositoryEnMemoria } from '../infrastructure/notification.repository.fake'
import { RealtimePortEnMemoria } from '../infrastructure/realtime.port.fake'
import { BroadcastNoticeUseCase } from './broadcast-notice.use-case'
import { ListNotificationsUseCase } from './list-notifications.use-case'
import { MarkReadUseCase } from './mark-read.use-case'

const BASE = new Date('2026-03-01T00:00:00.000Z')

function fila(datos: {
  id: string
  userId?: string
  eventId?: string
  minuto: number
  leida?: boolean
}) {
  return {
    id: datos.id,
    eventId: datos.eventId ?? 'ev-1',
    userId: datos.userId ?? 'pareja',
    type: 'guest.rsvp.updated',
    payload: { minuto: datos.minuto },
    readAt: datos.leida === true ? BASE : null,
    createdAt: new Date(BASE.getTime() + datos.minuto * 60_000),
  }
}

describe('ListNotificationsUseCase', () => {
  it('devuelve la página y el total de no leídas, contado sobre las filas', async () => {
    const repo = new NotificationRepositoryEnMemoria()
    repo.filas.push(
      fila({ id: 'a', minuto: 1 }),
      fila({ id: 'b', minuto: 2, leida: true }),
      fila({ id: 'c', minuto: 3 }),
      fila({ id: 'd', minuto: 4, userId: 'planner' }),
    )

    const resultado = await new ListNotificationsUseCase(repo).ejecutar('ev-1', 'pareja', {
      desde: null,
      limite: 2,
      soloNoLeidas: false,
    })

    expect(resultado.items.map((n) => n.id)).toEqual(['c', 'b'])
    expect(resultado.unreadCount).toBe(2)
    expect(decodeCursor(resultado.nextCursor ?? '').id).toBe('b')
  })
})

describe('MarkReadUseCase', () => {
  it('marca la propia', async () => {
    const repo = new NotificationRepositoryEnMemoria()
    repo.filas.push(fila({ id: 'a', minuto: 1 }))

    await new MarkReadUseCase(repo).ejecutar('ev-1', 'pareja', 'a')

    expect(repo.filas[0]?.readAt).toBeInstanceOf(Date)
  })

  it('una ajena, o de otro evento, es NotificacionNoEncontradaError', async () => {
    const repo = new NotificationRepositoryEnMemoria()
    repo.filas.push(fila({ id: 'a', minuto: 1, userId: 'planner' }))
    repo.filas.push(fila({ id: 'b', minuto: 1, eventId: 'ev-2' }))
    const caso = new MarkReadUseCase(repo)

    await expect(caso.ejecutar('ev-1', 'pareja', 'a')).rejects.toThrow(
      NotificacionNoEncontradaError,
    )
    await expect(caso.ejecutar('ev-1', 'pareja', 'b')).rejects.toThrow(
      NotificacionNoEncontradaError,
    )
    expect(repo.filas.every((n) => n.readAt === null)).toBe(true)
  })
})

describe('BroadcastNoticeUseCase', () => {
  it('avisarDeNotificacion: el cambio a la sala del evento y notification.created a cada destinatario', async () => {
    const repo = new NotificationRepositoryEnMemoria()
    repo.registrarMiembros('ev-1', ['pareja', 'planner'])
    const realtime = new RealtimePortEnMemoria()
    const payload = { guestId: 'g-1', guestName: 'Ana', rsvp: 'CONFIRMED' }

    await new BroadcastNoticeUseCase(realtime, repo).avisarDeNotificacion(
      'ev-1',
      'guest.rsvp.updated',
      payload,
    )

    expect(realtime.emitidas).toEqual([
      { destino: { eventId: 'ev-1' }, tipo: 'guest.rsvp.updated', payload },
      {
        destino: { userId: 'pareja' },
        tipo: 'notification.created',
        payload: { eventId: 'ev-1', type: 'guest.rsvp.updated' },
      },
      {
        destino: { userId: 'planner' },
        tipo: 'notification.created',
        payload: { eventId: 'ev-1', type: 'guest.rsvp.updated' },
      },
    ])
  })

  it('avisarDeCambio: sólo la sala del evento; no hay notificación detrás', async () => {
    const repo = new NotificationRepositoryEnMemoria()
    repo.registrarMiembros('ev-1', ['pareja'])
    const realtime = new RealtimePortEnMemoria()

    await new BroadcastNoticeUseCase(realtime, repo).avisarDeCambio('ev-1', 'x', { a: 1 })

    expect(realtime.emitidas).toEqual([
      { destino: { eventId: 'ev-1' }, tipo: 'x', payload: { a: 1 } },
    ])
  })

  it('si la emisión falla, el error SALE: es lo que hace que el job se reintente', async () => {
    const repo = new NotificationRepositoryEnMemoria()
    const realtime = new RealtimePortEnMemoria()
    realtime.fallarProximaEmision(new Error('redis caído'))

    await expect(
      new BroadcastNoticeUseCase(realtime, repo).avisarDeNotificacion('ev-1', 't', {}),
    ).rejects.toThrow('redis caído')
  })
})
