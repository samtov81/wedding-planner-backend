import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'
import { ConflictError, UnprocessableError } from '@/shared/domain'

import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'
import { InviteMemberUseCase } from './invite-member.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'

describe('InviteMemberUseCase', () => {
  let eventos: EventRepositoryEnMemoria
  let usuarios: UserRepositoryEnMemoria
  let cola: InMemoryQueueAdapter
  let caso: InviteMemberUseCase
  let anaId: string
  let pedroId: string

  beforeEach(async () => {
    eventos = new EventRepositoryEnMemoria()
    usuarios = new UserRepositoryEnMemoria()
    cola = new InMemoryQueueAdapter()
    caso = new InviteMemberUseCase(eventos, usuarios, cola)

    const ana = await usuarios.create({ email: 'ana@test.com', passwordHash: 'x', fullName: 'Ana' })
    const pedro = await usuarios.create({
      email: 'pedro@test.com',
      passwordHash: 'x',
      fullName: 'Pedro',
    })
    anaId = ana.id
    pedroId = pedro.id

    eventos.eventos.push({ id: EVENTO, ownerId: anaId, name: 'Boda de Ana' })
    eventos.membresias.push({ eventId: EVENTO, userId: anaId, role: 'COUPLE', status: 'ACTIVE' })
  })

  it('crea la membresía en INVITED: invitar no es dar acceso todavía', async () => {
    await caso.ejecutar({
      eventId: EVENTO,
      email: 'pedro@test.com',
      role: 'PLANNER',
      invitedById: anaId,
    })

    expect(await eventos.buscarMembresia(EVENTO, pedroId)).toMatchObject({
      role: 'PLANNER',
      status: 'INVITED',
    })
    // Y por tanto todavía no abre ninguna puerta.
    expect(await eventos.buscarMembresiaActiva(EVENTO, pedroId)).toBeNull()
  })

  it('encola el correo en vez de enviarlo en línea', async () => {
    await caso.ejecutar({
      eventId: EVENTO,
      email: 'pedro@test.com',
      role: 'PLANNER',
      invitedById: anaId,
    })

    expect(cola.encolados).toHaveLength(1)
    expect(cola.encolados[0]).toMatchObject({ cola: 'email', nombre: 'event-invitation' })
  })

  it('deja rastro en la auditoría de quién invitó a quién', async () => {
    await caso.ejecutar({
      eventId: EVENTO,
      email: 'pedro@test.com',
      role: 'PLANNER',
      invitedById: anaId,
    })

    expect(eventos.auditoria).toEqual([
      {
        actorUserId: anaId,
        eventId: EVENTO,
        action: 'event.member.invited',
        target: `user:${pedroId}`,
      },
    ])
  })

  it('rechaza invitar a un email sin cuenta: no hay dónde colgar la membresía', async () => {
    await expect(
      caso.ejecutar({
        eventId: EVENTO,
        email: 'nadie@test.com',
        role: 'PLANNER',
        invitedById: anaId,
      }),
    ).rejects.toBeInstanceOf(UnprocessableError)

    expect(cola.encolados).toHaveLength(0)
  })

  it('rechaza invitar a quien ya es miembro activo', async () => {
    await expect(
      caso.ejecutar({
        eventId: EVENTO,
        email: 'ana@test.com',
        role: 'PLANNER',
        invitedById: anaId,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('rechaza invitar dos veces a la misma persona', async () => {
    await caso.ejecutar({
      eventId: EVENTO,
      email: 'pedro@test.com',
      role: 'PLANNER',
      invitedById: anaId,
    })

    await expect(
      caso.ejecutar({
        eventId: EVENTO,
        email: 'pedro@test.com',
        role: 'PLANNER',
        invitedById: anaId,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('vuelve a admitir a quien fue expulsado: REVOKED no es una condena', async () => {
    eventos.membresias.push({
      id: 'm-vieja',
      eventId: EVENTO,
      userId: pedroId,
      role: 'PLANNER',
      status: 'REVOKED',
    })

    await caso.ejecutar({
      eventId: EVENTO,
      email: 'pedro@test.com',
      role: 'COUPLE',
      invitedById: anaId,
    })

    expect(await eventos.buscarMembresia(EVENTO, pedroId)).toMatchObject({
      role: 'COUPLE',
      status: 'INVITED',
    })
  })
})
