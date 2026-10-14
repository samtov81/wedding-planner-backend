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
  let repo: EventRepositoryEnMemoria
  let piaId: string

  beforeEach(async () => {
    repo = new EventRepositoryEnMemoria()
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
      new RevokeMemberUseCase(repo).ejecutar({
        eventId: EVENTO,
        membershipId: 'm-ana',
        actorId: ANA,
      }),
    ).rejects.toMatchObject({ code: 'OWNER_MEMBERSHIP_IMMUTABLE' })
    expect(repo.auditoria).toHaveLength(antes)
  })

  it('revocar deja REVOKED, quita el grant y luego es 404', async () => {
    await repo.actualizarMembresia(EVENTO, piaId, { budgetView: true }, ANA)
    const caso = new RevokeMemberUseCase(repo)
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

  it('rechazar responde NO_PENDING_INVITATION si la escritura condicional no escribe', async () => {
    repo.revocarMembresia = () => Promise.resolve(false)
    await expect(new DeclineInvitationUseCase(repo).ejecutar(EVENTO, PIA)).rejects.toMatchObject({
      code: 'NO_PENDING_INVITATION',
    })
  })
})
