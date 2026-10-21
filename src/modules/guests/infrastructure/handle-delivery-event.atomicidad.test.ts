import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { PrismaUnidadDeTrabajo } from '@/modules/database/transaccion'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import { HandleDeliveryEventUseCase } from '../application/handle-delivery-event.use-case'
import { PrismaInvitationRepository } from './prisma-invitation.repository'

/**
 * `UnidadDeTrabajoEnMemoria` no deshace nada, así que con los dobles un
 * `crearParaMiembros` sacado de la transacción seguiría en verde. Aquí la
 * unidad de trabajo y el repositorio son los reales, contra Postgres.
 */
describe('HandleDeliveryEventUseCase — atomicidad contra Postgres', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let guestId: string
  let eventId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const owner = await prisma.user.create({
      data: { email: 'owner@atomicidad.test', passwordHash: 'x', fullName: 'Owner' },
    })
    const evento = await prisma.event.create({
      data: { name: 'Boda', weddingDate: new Date('2027-06-12'), ownerId: owner.id },
    })
    const invitado = await prisma.guest.create({
      data: { eventId: evento.id, name: 'Invitada', email: 'i@test.com', group: 'Family' },
    })
    eventId = evento.id
    guestId = invitado.id
  }, 240_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  it('si crear la notificación falla, el rebote se deshace y la invitación sigue como estaba', async () => {
    const mensaje = `re_${randomUUID()}`
    const { id } = await prisma.guestInvitation.create({
      data: {
        guestId,
        tokenHash: randomUUID(),
        status: 'SENT',
        resendMessageId: mensaje,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    const servicio = prisma as unknown as PrismaService
    const notificaciones = new NotificationPortEnMemoria()
    notificaciones.registrarMiembros(eventId, ['pareja'])
    notificaciones.fallarProximaCreacion(new Error('base de datos caída'))
    const cola = new InMemoryQueueAdapter()
    const caso = new HandleDeliveryEventUseCase(
      new PrismaInvitationRepository(servicio),
      notificaciones,
      cola,
      new PrismaUnidadDeTrabajo(servicio),
    )

    await expect(caso.ejecutar({ type: 'email.bounced', messageId: mensaje })).rejects.toThrow(
      'base de datos caída',
    )

    expect((await prisma.guestInvitation.findUnique({ where: { id } }))?.status).toBe('SENT')
    expect(notificaciones.creadas).toEqual([])
    expect(cola.encolados).toEqual([])
  })
})
