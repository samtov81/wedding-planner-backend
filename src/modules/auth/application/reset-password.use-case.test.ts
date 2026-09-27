import { Logger } from '@nestjs/common'

import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import type { PasswordHasher } from '@/modules/users/application/password-hasher.port'
import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { TokenResetInvalidoError } from '../domain/auth-errors'
import { PasswordResetTokenRepositoryFake } from '../infrastructure/password-reset-token.repository.fake'
import { SessionRepositoryEnMemoria } from '../infrastructure/session.repository.fake'
import { ResetPasswordUseCase } from './reset-password.use-case'
import { hashToken } from './token.service'

/** Hash de mentira: `hash:<plano>`, como en login.use-case.test.ts. */
const hasher: PasswordHasher = {
  hash: (plano) => Promise.resolve(`hash:${plano}`),
  verify: (hash, plano) => Promise.resolve(hash === `hash:${plano}`),
}

const AHORA = Date.now()

describe('ResetPasswordUseCase', () => {
  let tokens: PasswordResetTokenRepositoryFake
  let usuarios: UserRepositoryEnMemoria
  let sesiones: SessionRepositoryEnMemoria
  let uow: UnidadDeTrabajoEnMemoria
  let cola: InMemoryQueueAdapter
  let caso: ResetPasswordUseCase

  beforeEach(async () => {
    usuarios = new UserRepositoryEnMemoria([
      {
        id: 'u-1',
        email: 'ana@test.com',
        fullName: 'Ana',
        systemRole: 'USER',
        emailVerifiedAt: null,
        passwordHash: 'hash:vieja',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    tokens = new PasswordResetTokenRepositoryFake()
    sesiones = new SessionRepositoryEnMemoria()
    uow = new UnidadDeTrabajoEnMemoria()
    cola = new InMemoryQueueAdapter()
    caso = new ResetPasswordUseCase(tokens, usuarios, sesiones, hasher, uow, cola)

    await tokens.crear({ userId: 'u-1', tokenHash: hashToken('bueno'), expiresAt: new Date(AHORA + 600_000) })
    await tokens.crear({ userId: 'u-1', tokenHash: hashToken('caducado'), expiresAt: new Date(AHORA - 1) })
    for (const familyId of ['f-1', 'f-2']) {
      await sesiones.crear({ userId: 'u-1', tokenHash: `s-${familyId}`, familyId, expiresAt: new Date(AHORA + 86_400_000) })
    }
  })

  it('cambia la contraseña, marca verificado, revoca sesiones y encola el aviso', async () => {
    await caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })

    const usuario = await usuarios.findByEmail('ana@test.com')
    expect(usuario?.passwordHash).toBe('hash:una-nueva-larga')
    expect(usuario?.emailVerifiedAt).toBeInstanceOf(Date)
    expect(sesiones.vivasDeUsuario('u-1')).toBe(0)
    expect(uow.transacciones).toBe(1)

    expect(cola.encolados).toHaveLength(1)
    const aviso = cola.encolados[0]
    expect(aviso?.nombre).toBe('send-password-changed-notice')
    const datos = aviso?.datos as { userId: string; tokenId: string; email: string; fullName: string; cambiadoEn: string }
    expect(datos).toEqual({
      userId: 'u-1',
      tokenId: 'reset-1',
      email: 'ana@test.com',
      fullName: 'Ana',
      cambiadoEn: expect.any(String) as string,
    })
    // ISO, no `new Date()` en el worker: la hora es la de la transacción, no la
    // de cuando la cola llegue a procesar el job.
    expect(new Date(datos.cambiadoEn).toISOString()).toBe(datos.cambiadoEn)
    expect(aviso?.jobId).toBe('password-changed-reset-1')
    expect(aviso?.opciones.removeOnComplete).toBe(true)
  })

  it('el mismo token no sirve dos veces', async () => {
    await caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })

    await expect(caso.ejecutar({ token: 'bueno', password: 'otra-mas-larga' })).rejects.toBeInstanceOf(
      TokenResetInvalidoError,
    )
    expect((await usuarios.findByEmail('ana@test.com'))?.passwordHash).toBe('hash:una-nueva-larga')
  })

  it.each([['caducado'], ['inexistente']])('token %s → TokenResetInvalidoError sin efectos', async (token) => {
    await expect(caso.ejecutar({ token, password: 'una-nueva-larga' })).rejects.toBeInstanceOf(
      TokenResetInvalidoError,
    )

    expect((await usuarios.findByEmail('ana@test.com'))?.passwordHash).toBe('hash:vieja')
    expect(sesiones.vivasDeUsuario('u-1')).toBe(2)
    expect(cola.encolados).toHaveLength(0)
  })

  it('las escrituras corren dentro de la unidad de trabajo', async () => {
    const dentro: boolean[] = []
    const original = sesiones.revocarTodasDeUsuario.bind(sesiones)
    vi.spyOn(sesiones, 'revocarTodasDeUsuario').mockImplementation(async (id) => {
      dentro.push(uow.activa)
      await original(id)
    })

    await caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })

    expect(dentro).toEqual([true])
  })

  it('un fallo dentro de la transacción se propaga y no encola el aviso', async () => {
    vi.spyOn(sesiones, 'revocarTodasDeUsuario').mockRejectedValue(new Error('BD caída'))

    await expect(caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })).rejects.toThrow('BD caída')
    expect(cola.encolados).toHaveLength(0)
  })

  it('si falla encolar el aviso, el reset sigue contando como hecho', async () => {
    const errorEspia = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const encolarEspia = vi.spyOn(cola, 'enqueue').mockRejectedValue(new Error('Redis caído'))

    await expect(caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })).resolves.toBeUndefined()
    expect((await usuarios.findByEmail('ana@test.com'))?.passwordHash).toBe('hash:una-nueva-larga')
    expect(encolarEspia).toHaveBeenCalled()
    expect(errorEspia).toHaveBeenCalled()
  })

  it('caduca cualquier otro enlace vivo del usuario', async () => {
    await tokens.crear({ userId: 'u-1', tokenHash: hashToken('otro'), expiresAt: new Date(AHORA + 600_000) })

    await caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })

    expect(await tokens.consumirPorHash(hashToken('otro'), new Date())).toBeNull()
  })
})
