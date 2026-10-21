import { Logger } from '@nestjs/common'

import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'
import {
  AcceptInvitationUseCase,
  DeclineInvitationUseCase,
  ListMembersUseCase,
  ListMyInvitationsUseCase,
  RevokeMemberUseCase,
  UpdateMemberUseCase,
} from './members.use-cases'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const ANA = 'ana'
const PIA = 'pia'

describe('casos de uso de miembros', () => {
  afterEach(() => vi.restoreAllMocks())

  let repo: EventRepositoryEnMemoria
  let cola: InMemoryQueueAdapter
  let piaId: string

  beforeEach(async () => {
    repo = new EventRepositoryEnMemoria()
    cola = new InMemoryQueueAdapter()
    repo.eventos.push({ id: EVENTO, ownerId: ANA, name: 'Boda de Ana' })
    repo.membresias.push({
      id: 'm-ana',
      eventId: EVENTO,
      userId: ANA,
      role: 'COUPLE',
      status: 'ACTIVE',
    })
    repo.usuarios.push(
      { id: ANA, fullName: 'Ana', email: 'ana@test.com' },
      { id: PIA, fullName: 'Pia', email: 'pia@test.com' },
    )
    piaId = (
      await repo.invitarMiembro({ eventId: EVENTO, userId: PIA, role: 'PLANNER', invitedById: ANA })
    ).id
  })

  it('listar traduce owner/grant a budgetAccess', async () => {
    await repo.actualizarMembresia(EVENTO, piaId, { budgetView: true }, ANA)
    const miembros = await new ListMembersUseCase(repo).ejecutar(EVENTO)
    expect(miembros.map((m) => [m.fullName, m.budgetAccess])).toEqual([
      ['Ana', 'edit'],
      ['Pia', 'view'],
    ])
  })

  it('actualizar concede ver, cambia el rol y devuelve el miembro', async () => {
    const caso = new UpdateMemberUseCase(repo)
    expect(
      await caso.ejecutar({
        eventId: EVENTO,
        membershipId: piaId,
        actorId: ANA,
        budgetAccess: 'view',
      }),
    ).toMatchObject({ budgetAccess: 'view', role: 'PLANNER' })
    expect(
      await caso.ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA, role: 'COUPLE' }),
    ).toMatchObject({ budgetAccess: 'view', role: 'COUPLE' })
  })

  it('actualizar relee sólo su fila, no la lista entera del evento', async () => {
    repo.listarMiembros = () => Promise.reject(new Error('no debería listar el evento'))
    expect(
      await new UpdateMemberUseCase(repo).ejecutar({
        eventId: EVENTO,
        membershipId: piaId,
        actorId: ANA,
        budgetAccess: 'view',
      }),
    ).toMatchObject({ id: piaId, fullName: 'Pia', budgetAccess: 'view' })
  })

  it('actualizar o revocar al creador es 422 y no deja auditoría', async () => {
    const antes = repo.auditoria.length
    await expect(
      new UpdateMemberUseCase(repo).ejecutar({
        eventId: EVENTO,
        membershipId: 'm-ana',
        actorId: ANA,
        budgetAccess: 'none',
      }),
    ).rejects.toMatchObject({ code: 'OWNER_MEMBERSHIP_IMMUTABLE' })
    await expect(
      new RevokeMemberUseCase(repo, cola).ejecutar({
        eventId: EVENTO,
        membershipId: 'm-ana',
        actorId: ANA,
      }),
    ).rejects.toMatchObject({ code: 'OWNER_MEMBERSHIP_IMMUTABLE' })
    expect(repo.auditoria).toHaveLength(antes)
  })

  it('revocar deja REVOKED, quita el grant y luego es 404', async () => {
    await repo.actualizarMembresia(EVENTO, piaId, { budgetView: true }, ANA)
    const caso = new RevokeMemberUseCase(repo, cola)
    await caso.ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA })
    expect(await repo.buscarMembresiaPorId(EVENTO, piaId)).toMatchObject({
      status: 'REVOKED',
      budgetView: false,
    })
    await expect(
      caso.ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA }),
    ).rejects.toMatchObject({
      code: 'MEMBER_NOT_FOUND',
    })
  })

  it('cancelar una invitación pendiente encola el aviso de cancelada', async () => {
    await new RevokeMemberUseCase(repo, cola).ejecutar({
      eventId: EVENTO,
      membershipId: piaId,
      actorId: ANA,
    })
    expect(cola.encolados).toEqual([
      expect.objectContaining({
        cola: 'notifications',
        nombre: 'invitacion-de-miembro',
        datos: { userId: PIA, eventId: EVENTO, cambio: 'cancelada' },
      }),
    ])
  })

  it('revocar a un miembro ACTIVE no encola aviso de invitación', async () => {
    await repo.aceptarInvitacion(EVENTO, PIA)
    await new RevokeMemberUseCase(repo, cola).ejecutar({
      eventId: EVENTO,
      membershipId: piaId,
      actorId: ANA,
    })
    expect(cola.encolados).toEqual([])
  })

  it('si la escritura no se hace (carrera), no encola nada', async () => {
    repo.revocarMembresia = () => Promise.resolve(false)
    await expect(
      new RevokeMemberUseCase(repo, cola).ejecutar({
        eventId: EVENTO,
        membershipId: piaId,
        actorId: ANA,
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
    expect(cola.encolados).toEqual([])
  })

  it('si no se puede encolar, la cancelación queda hecha igualmente', async () => {
    const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    cola.enqueue = () => Promise.reject(new Error('redis caído'))
    await new RevokeMemberUseCase(repo, cola).ejecutar({
      eventId: EVENTO,
      membershipId: piaId,
      actorId: ANA,
    })
    expect(await repo.buscarMembresiaPorId(EVENTO, piaId)).toMatchObject({ status: 'REVOKED' })
    // El fallo no se propaga, pero tampoco se pierde en silencio.
    expect(aviso).toHaveBeenCalledOnce()
    expect(aviso).toHaveBeenCalledWith(
      `Invitación cancelada pero su aviso no se pudo encolar eventId=${EVENTO} membershipId=${piaId}: redis caído`,
    )
  })

  it('una membresía de otro evento es 404', async () => {
    await expect(
      new UpdateMemberUseCase(repo).ejecutar({
        eventId: 'otro',
        membershipId: piaId,
        actorId: ANA,
        role: 'COUPLE',
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
  })

  it('si la membresía cambia entre leer y escribir, 404', async () => {
    // Simula la carrera: la escritura condicional no encuentra una fila viva.
    repo.actualizarMembresia = () => Promise.resolve(false)
    await expect(
      new UpdateMemberUseCase(repo).ejecutar({
        eventId: EVENTO,
        membershipId: piaId,
        actorId: ANA,
        role: 'COUPLE',
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
  })

  it('el invitado ve su invitación, la acepta y entra; aceptar otra vez es 404', async () => {
    expect(await new ListMyInvitationsUseCase(repo).ejecutar(PIA)).toMatchObject([
      { eventId: EVENTO, eventName: 'Boda de Ana', invitedByName: 'Ana' },
    ])
    const aceptar = new AcceptInvitationUseCase(repo)
    await aceptar.ejecutar(EVENTO, PIA)
    expect(await repo.buscarMembresiaActiva(EVENTO, PIA)).not.toBeNull()
    await expect(aceptar.ejecutar(EVENTO, PIA)).rejects.toMatchObject({
      code: 'NO_PENDING_INVITATION',
    })
  })

  it('rechazar deja REVOKED y no da acceso; sin invitación es 404', async () => {
    const rechazar = new DeclineInvitationUseCase(repo)
    await rechazar.ejecutar(EVENTO, PIA)
    expect(await repo.buscarMembresiaPorId(EVENTO, piaId)).toMatchObject({ status: 'REVOKED' })
    expect(repo.auditoria.at(-1)).toMatchObject({
      action: 'event.member.declined',
      actorUserId: PIA,
    })
    await expect(rechazar.ejecutar(EVENTO, PIA)).rejects.toMatchObject({
      code: 'NO_PENDING_INVITATION',
    })
    await expect(rechazar.ejecutar(EVENTO, 'extraño')).rejects.toMatchObject({
      code: 'NO_PENDING_INVITATION',
    })
  })

  it('aceptar responde NO_PENDING_INVITATION si la escritura condicional no escribe', async () => {
    // La carrera: la invitación seguía INVITED al leerla, pero otra petición
    // (un rechazo, una revocación) la cambió antes del UPDATE condicional.
    repo.aceptarInvitacion = () => Promise.resolve(false)
    await expect(new AcceptInvitationUseCase(repo).ejecutar(EVENTO, PIA)).rejects.toMatchObject({
      code: 'NO_PENDING_INVITATION',
    })
  })

  it('rechazar responde NO_PENDING_INVITATION si la escritura condicional no escribe', async () => {
    repo.revocarMembresia = () => Promise.resolve(false)
    await expect(new DeclineInvitationUseCase(repo).ejecutar(EVENTO, PIA)).rejects.toMatchObject({
      code: 'NO_PENDING_INVITATION',
    })
  })
})
