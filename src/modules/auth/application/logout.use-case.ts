import { Inject, Injectable } from '@nestjs/common'

import { SESSION_REPOSITORY, type SessionRepository } from './session.repository'
import { hashToken } from './token.service'

@Injectable()
export class LogoutUseCase {
  constructor(@Inject(SESSION_REPOSITORY) private readonly sesiones: SessionRepository) {}

  /**
   * Revoca la FAMILIA entera, no sólo el token presentado: cerrar sesión
   * cierra el dispositivo completo, no un único refresh de su cadena.
   * Un token ya inválido (inexistente o revocado) no es un error: cerrar
   * sesión dos veces, o con una cookie caducada, tiene que ser un no-op.
   */
  async ejecutar(refreshToken: string): Promise<void> {
    const sesion = await this.sesiones.buscarPorHash(hashToken(refreshToken))
    if (sesion !== null) await this.sesiones.revocarFamilia(sesion.familyId)
  }
}
