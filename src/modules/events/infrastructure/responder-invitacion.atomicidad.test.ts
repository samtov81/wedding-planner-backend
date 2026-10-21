import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { PrismaUnidadDeTrabajo } from '@/modules/database/transaccion'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import { AcceptInvitationUseCase, DeclineInvitationUseCase } from '../application/members.use-cases'
import { PrismaEventRepository } from './prisma-event.repository'

/**
 * `UnidadDeTrabajoEnMemoria` no deshace nada, así que con los dobles un
 * `crearParaDueno` sacado de la transacción dejaría la membresía cambiada y el
 * test en verde. Aquí la unidad de trabajo y los repositorios son los reales,
 * contra Postgres: lo que se prueba es que `aceptarInvitacion` y
 * `revocarMembresia` se UNEN a la transacción del caso de uso (`enTransaccion`)
 * en vez de abrir la suya.
 */
describe('Responder una invitación de equipo — atomicidad contra Postgres', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let eventId: string
  let invitadoId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const dueno = await prisma.user.create({
      data: { email: 'dueno@atomicidad.test', passwordHash: 'x', fullName: 'Dueña' },
    })
    const invitado = await prisma.user.create({
      data: { email: 'invitado@atomicidad.test', passwordHash: 'x', fullName: 'Invitado' },
    })
    const evento = await prisma.event.create({
      data: { name: 'Boda', weddingDate: new Date('2027-06-12'), ownerId: dueno.id },
    })
    eventId = evento.id
    invitadoId = invitado.id
  }, 240_000)

  beforeEach(async () => {
    await prisma.auditLog.deleteMany()
    await prisma.eventMembership.deleteMany()
    await prisma.eventMembership.create({
      data: { eventId, userId: invitadoId, role: 'PLANNER', status: 'INVITED' },
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  function armar() {
    const servicio = prisma as unknown as PrismaService
    const notificaciones = new NotificationPortEnMemoria()
    notificaciones.fallarProximaCreacion(new Error('base de datos caída'))
    const cola = new InMemoryQueueAdapter()
    const dependencias = [
      new PrismaEventRepository(servicio),
      notificaciones,
      new PrismaUnidadDeTrabajo(servicio),
      cola,
      // Sólo se lee el nombre de quien responde: el doble basta, no es lo que se prueba.
      new UserRepositoryEnMemoria([
        {
          id: invitadoId,
          email: 'invitado@atomicidad.test',
          fullName: 'Invitado',
          systemRole: 'USER',
          emailVerifiedAt: null,
          passwordHash: 'x',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    ] as const
    return { notificaciones, cola, dependencias }
  }

  async function estadoDeLaMembresia() {
    const fila = await prisma.eventMembership.findFirst({ where: { eventId, userId: invitadoId } })
    return fila?.status
  }

  it('si crear la notificación falla, aceptar se deshace: sigue INVITED y sin auditoría', async () => {
    const { notificaciones, cola, dependencias } = armar()

    await expect(
      new AcceptInvitationUseCase(...dependencias).ejecutar(eventId, invitadoId),
    ).rejects.toThrow('base de datos caída')

    expect(await estadoDeLaMembresia()).toBe('INVITED')
    expect(await prisma.auditLog.count()).toBe(0)
    expect(notificaciones.creadas).toEqual([])
    expect(cola.encolados).toEqual([])
  })

  it('si crear la notificación falla, rechazar se deshace: sigue INVITED y sin auditoría', async () => {
    const { notificaciones, cola, dependencias } = armar()

    await expect(
      new DeclineInvitationUseCase(...dependencias).ejecutar(eventId, invitadoId),
    ).rejects.toThrow('base de datos caída')

    expect(await estadoDeLaMembresia()).toBe('INVITED')
    expect(await prisma.auditLog.count()).toBe(0)
    expect(notificaciones.creadas).toEqual([])
    expect(cola.encolados).toEqual([])
  })
})
