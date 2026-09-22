import { Inject, Injectable } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'

import { caducidadVerificacion, generarTokenVerificacion } from '../domain/email-verification'
import {
  EMAIL_VERIFICATION_TOKEN_REPOSITORY,
  type EmailVerificationTokenRepository,
} from './email-verification-token.repository'
import { hashToken } from './token.service'

/**
 * Reenvío del correo de verificación.
 *
 * Devuelve `void` SIEMPRE, y nunca lanza por el estado de la cuenta: cuenta
 * inexistente, cuenta ya verificada y cuenta pendiente son indistinguibles
 * desde fuera. Cualquier dato que saliera de aquí —un booleano, un error, un
 * conteo— acabaría en la respuesta HTTP y convertiría el endpoint en un
 * enumerador de cuentas, que es justo lo que `LoginUseCase` evita pagando
 * Argon2 contra un hash señuelo.
 */
@Injectable()
export class ResendVerificationUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    @Inject(EMAIL_VERIFICATION_TOKEN_REPOSITORY)
    private readonly tokens: EmailVerificationTokenRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async ejecutar(datos: { email: string }): Promise<void> {
    // Misma normalización que RegisterUseCase: el correo se guardó en
    // minúsculas y sin espacios, así que buscarlo tal cual lo escribió el
    // usuario no encontraría nada y el reenvío fallaría en silencio.
    const email = datos.email.trim().toLowerCase()
    const usuario = await this.usuarios.findByEmail(email)

    if (usuario === null || usuario.emailVerifiedAt !== null) return

    const ahora = new Date()
    // Un solo enlace vivo por usuario: dos enlaces válidos a la vez alargan sin
    // motivo la ventana en la que un correo viejo filtrado sigue sirviendo.
    await this.tokens.caducarVigentesDe(usuario.id, ahora)

    const tokenEnClaro = generarTokenVerificacion()
    const { id: tokenId } = await this.tokens.crear({
      userId: usuario.id,
      tokenHash: hashToken(tokenEnClaro),
      expiresAt: caducidadVerificacion(this.env.EMAIL_VERIFICATION_TTL_HOURS, ahora),
    })

    await this.cola.enqueue(
      'email',
      'send-verification-email',
      {
        userId: usuario.id,
        tokenId,
        email: usuario.email,
        fullName: usuario.fullName,
        token: tokenEnClaro,
      },
      // removeOnComplete obligatorio: el payload lleva el token en claro.
      { jobId: `verify-email-${tokenId}`, removeOnComplete: true },
    )
  }
}
