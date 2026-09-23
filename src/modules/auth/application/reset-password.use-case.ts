import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import { PASSWORD_HASHER, type PasswordHasher } from '@/modules/users/application/password-hasher.port'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'

import { TokenResetInvalidoError } from '../domain/auth-errors'
import {
  PASSWORD_RESET_TOKEN_REPOSITORY,
  type PasswordResetTokenRepository,
} from './password-reset-token.repository'
import { SESSION_REPOSITORY, type SessionRepository } from './session.repository'
import { hashToken } from './token.service'

/**
 * Fija la contraseña nueva a partir de un enlace de recuperación.
 *
 * Consumir el token, cambiar el hash, marcar el email verificado, revocar
 * TODAS las sesiones y caducar los demás enlaces van en UNA unidad de trabajo:
 * a medias, quedaría o un token gastado sin contraseña nueva, o una contraseña
 * nueva con las sesiones del atacante vivas.
 *
 * El Argon2 va ANTES y fuera de la transacción: son decenas de milisegundos de
 * CPU que no deben retener una conexión de la base de datos. Si el token luego
 * resulta inválido, ese trabajo se tira; es el precio de no bloquear el pool.
 *
 * No crea sesión: el enlace del correo nunca equivale a un login.
 */
@Injectable()
export class ResetPasswordUseCase {
  private readonly logger = new Logger(ResetPasswordUseCase.name)

  constructor(
    @Inject(PASSWORD_RESET_TOKEN_REPOSITORY) private readonly tokens: PasswordResetTokenRepository,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    @Inject(SESSION_REPOSITORY) private readonly sesiones: SessionRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(UNIDAD_DE_TRABAJO) private readonly uow: UnidadDeTrabajo,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(datos: { token: string; password: string }): Promise<void> {
    const passwordHash = await this.hasher.hash(datos.password)

    const consumido = await this.uow.ejecutar(async () => {
      const ahora = new Date()
      const token = await this.tokens.consumirPorHash(hashToken(datos.token), ahora)
      // eslint-disable-next-line security/detect-possible-timing-attacks -- no se compara un secreto: sólo se mira si `consumirPorHash` devolvió fila o no
      if (token === null) throw new TokenResetInvalidoError()

      await this.usuarios.actualizarPassword(token.userId, passwordHash)
      await this.sesiones.revocarTodasDeUsuario(token.userId)
      await this.tokens.caducarVigentesDe(token.userId, ahora)
      return token
    })

    await this.avisarDelCambio(consumido.userId, consumido.tokenId)
  }

  /**
   * Fuera de la transacción y sin propagar el error: la contraseña YA cambió;
   * contestar 500 haría que el usuario reintentase con un token ya gastado.
   */
  private async avisarDelCambio(userId: string, tokenId: string): Promise<void> {
    try {
      const usuario = await this.usuarios.findById(userId)
      if (usuario === null) return
      await this.cola.enqueue(
        'email',
        'send-password-changed-notice',
        { userId, tokenId, email: usuario.email, fullName: usuario.fullName },
        { jobId: `password-changed-${tokenId}`, removeOnComplete: true },
      )
    } catch (error) {
      this.logger.error('Fallo al encolar el aviso de cambio de contraseña', error as Error)
    }
  }
}
