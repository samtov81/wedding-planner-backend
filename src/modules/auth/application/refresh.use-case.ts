import { Inject, Injectable } from '@nestjs/common'

import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'

import { RefreshInvalidoError, RefreshReutilizadoError } from '../domain/token-errors'
import { SESSION_REPOSITORY, type SessionRepository } from './session.repository'
import { hashToken, TokenService } from './token.service'

@Injectable()
export class RefreshUseCase {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sesiones: SessionRepository,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    private readonly tokens: TokenService,
  ) {}

  async ejecutar(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const sesion = await this.sesiones.buscarPorHash(hashToken(refreshToken))

    if (sesion === null) throw new RefreshInvalidoError()

    // Presentar un refresh YA REVOCADO sólo tiene una explicación: el cliente
    // legítimo ya rotó y guarda el siguiente, así que quien trae éste lo copió.
    // Se cae la familia entera, no sólo esta sesión: si no, el ladrón sigue
    // usando el token válido que obtuvo por el camino.
    if (sesion.revokedAt !== null) {
      await this.sesiones.revocarFamilia(sesion.familyId)
      throw new RefreshReutilizadoError()
    }

    if (sesion.expiresAt.getTime() <= Date.now()) throw new RefreshInvalidoError()

    await this.sesiones.revocar(sesion.id)

    const nuevo = this.tokens.generarRefresh()
    await this.sesiones.crear({
      userId: sesion.userId,
      tokenHash: nuevo.hash,
      familyId: sesion.familyId,
      expiresAt: this.tokens.caducidadRefresh(),
    })

    // El rol se relee del usuario, NO se asume: firmar siempre 'USER' degradaría
    // a un admin en cuanto refrescara, y cachearlo en la sesión dejaría vivo el
    // rol antiguo durante toda la vida del refresh tras un cambio de permisos.
    const usuario = await this.usuarios.findById(sesion.userId)
    if (usuario === null) throw new RefreshInvalidoError()

    return {
      accessToken: this.tokens.firmarAccess({ id: usuario.id, systemRole: usuario.systemRole }),
      refreshToken: nuevo.token,
    }
  }
}
