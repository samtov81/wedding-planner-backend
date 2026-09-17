import type { ExecutionContext } from '@nestjs/common'
import { UnauthorizedException } from '@nestjs/common'

import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { TokenService } from '../application/token.service'
import { JwtAuthGuard } from './jwt-auth.guard'

interface RequestFalsa {
  headers: { authorization?: string }
  user?: unknown
}

function contexto(req: RequestFalsa): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
}

describe('JwtAuthGuard', () => {
  const tokens = new TokenService({
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    JWT_ACCESS_TTL: '15m',
    REFRESH_TTL_DAYS: 30,
  })
  let usuarios: UserRepositoryEnMemoria
  let guard: JwtAuthGuard

  beforeEach(() => {
    usuarios = new UserRepositoryEnMemoria([
      {
        id: 'user-1',
        email: 'ana@test.com',
        fullName: 'Ana',
        systemRole: 'ADMIN',
        emailVerifiedAt: null,
        passwordHash: 'irrelevante',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    guard = new JwtAuthGuard(tokens, usuarios)
  })

  it('recarga el usuario de la base de datos y lo deja entero en req.user', async () => {
    const token = tokens.firmarAccess({ id: 'user-1', systemRole: 'ADMIN' })
    const req: RequestFalsa = { headers: { authorization: `Bearer ${token}` } }

    await expect(guard.canActivate(contexto(req))).resolves.toBe(true)

    // Email y nombre no viajan en el token: si están, es que se leyó la fila.
    expect(req.user).toEqual({
      id: 'user-1',
      email: 'ana@test.com',
      fullName: 'Ana',
      systemRole: 'ADMIN',
    })
  })

  it('rechaza un token cuyo usuario ya no existe', async () => {
    const token = tokens.firmarAccess({ id: 'user-borrado', systemRole: 'USER' })

    // Sin recargar, un usuario borrado seguiría entrando hasta que caducara
    // su access token: quince minutos de acceso a una cuenta que no existe.
    await expect(
      guard.canActivate(contexto({ headers: { authorization: `Bearer ${token}` } })),
    ).rejects.toThrow(UnauthorizedException)
  })

  it('rechaza un rol que no pertenece a SystemRole', async () => {
    const token = tokens.firmarAccess({ id: 'user-1', systemRole: 'SUPERADMIN' })

    await expect(
      guard.canActivate(contexto({ headers: { authorization: `Bearer ${token}` } })),
    ).rejects.toThrow(UnauthorizedException)
  })

  it('rechaza una petición sin cabecera Authorization', async () => {
    await expect(guard.canActivate(contexto({ headers: {} }))).rejects.toThrow(
      UnauthorizedException,
    )
  })
})
