import { EventRepositoryEnMemoria } from './event.repository.fake'

const EVENTO = '11111111-1111-4111-8111-111111111111'

/**
 * Lo que el doble hace por su cuenta, sin contraparte en Prisma. Allí la FK
 * sólo cubre el join de `listarMiembros`; para quien invitó (`invitedById`, sin
 * FK) Prisma devolvería `null`, un caso que el doble trata a propósito como un
 * error de siembra. En el doble, un usuario sin sembrar es un error del TEST, y
 * se dice en vez de devolver `''` o `null`.
 */
describe('EventRepositoryEnMemoria', () => {
  let repo: EventRepositoryEnMemoria

  beforeEach(async () => {
    repo = new EventRepositoryEnMemoria()
    repo.eventos.push({ id: EVENTO, ownerId: 'ana' })
    await repo.invitarMiembro({
      eventId: EVENTO,
      userId: 'pia',
      role: 'PLANNER',
      invitedById: 'ana',
    })
  })

  it('listarMiembros lanza si un miembro no está sembrado en `usuarios`', async () => {
    repo.usuarios.push({ id: 'ana', fullName: 'Ana', email: 'ana@test.com' })
    await expect(repo.listarMiembros(EVENTO)).rejects.toThrow(/pia.*usuarios/)
  })

  it('listarInvitacionesPendientes lanza si quien invitó no está sembrado en `usuarios`', async () => {
    await expect(repo.listarInvitacionesPendientes('pia')).rejects.toThrow(/ana.*usuarios/)
  })

  it('con todos sembrados, lee nombre y email', async () => {
    repo.usuarios.push(
      { id: 'ana', fullName: 'Ana', email: 'ana@test.com' },
      { id: 'pia', fullName: 'Pia', email: 'pia@test.com' },
    )
    expect(await repo.listarMiembros(EVENTO)).toMatchObject([
      { fullName: 'Pia', email: 'pia@test.com' },
    ])
    expect(await repo.listarInvitacionesPendientes('pia')).toMatchObject([{ invitedByName: 'Ana' }])
  })
})
