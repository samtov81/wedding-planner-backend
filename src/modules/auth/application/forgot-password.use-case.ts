import { Inject, Injectable, Logger } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'
import type { User } from '@/modules/users/domain/user'

import { caducidadReset, generarTokenReset } from '../domain/password-reset'
import {
  PASSWORD_RESET_TOKEN_REPOSITORY,
  type PasswordResetTokenRepository,
} from './password-reset-token.repository'
import { hashToken } from './token.service'

/**
 * "Olvidé mi contraseña". Devuelve `void` SIEMPRE y nunca lanza por el estado
 * de la cuenta: inexistente, verificada y sin verificar son indistinguibles
 * desde fuera, igual que en `ResendVerificationUseCase` (ver su docblock).
 *
 * El trabajo (caducar el enlace anterior, crear el nuevo, encolar el correo)
 * corre SIN `await`: si la respuesta esperase a esas tres escrituras sólo
 * cuando la cuenta existe, cronometrarla diría quién tiene cuenta. El `.catch`
 * es obligatorio: una promesa rechazada sin manejador tumba el proceso.
 *
 * Las cuentas sin verificar también reciben el enlace: usarlo prueba el
 * control del buzón y `ResetPasswordUseCase` las marca verificadas.
 */
@Injectable()
export class ForgotPasswordUseCase {
  private readonly logger = new Logger(ForgotPasswordUseCase.name)

  constructor(
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    @Inject(PASSWORD_RESET_TOKEN_REPOSITORY) private readonly tokens: PasswordResetTokenRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async ejecutar(datos: { email: string }): Promise<void> {
    const usuario = await this.usuarios.findByEmail(datos.email.trim().toLowerCase())
    if (usuario === null) return

    // A propósito SIN `await`: ver el docblock de la clase.
    void this.emitirEnlace(usuario).catch((error: unknown) => {
      this.logger.error('Fallo al emitir el enlace de recuperación de contraseña', error as Error)
    })
  }

  private async emitirEnlace(usuario: Pick<User, 'id' | 'email' | 'fullName'>): Promise<void> {
    const ahora = new Date()
    // Un solo enlace vivo: un correo viejo filtrado deja de servir.
    await this.tokens.caducarVigentesDe(usuario.id, ahora)

    const tokenEnClaro = generarTokenReset()
    const { id: tokenId } = await this.tokens.crear({
      userId: usuario.id,
      tokenHash: hashToken(tokenEnClaro),
      expiresAt: caducidadReset(this.env.PASSWORD_RESET_TTL_MINUTES, ahora),
    })

    await this.cola.enqueue(
      'email',
      'send-password-reset-email',
      { userId: usuario.id, tokenId, email: usuario.email, fullName: usuario.fullName, token: tokenEnClaro },
      // removeOnComplete obligatorio: el payload lleva el token en claro.
      { jobId: `password-reset-${tokenId}`, removeOnComplete: true },
    )
  }
}
