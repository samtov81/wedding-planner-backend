import { Inject, Injectable } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import {
  PASSWORD_HASHER,
  type PasswordHasher,
} from '@/modules/users/application/password-hasher.port'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'
import { EmailYaRegistradoError } from '@/modules/users/domain/user-errors'
import type { User } from '@/modules/users/domain/user'
import { generarTokenVerificacion, caducidadVerificacion } from '../domain/email-verification'
import { hashToken } from './token.service'
import {
  EMAIL_VERIFICATION_TOKEN_REPOSITORY,
  type EmailVerificationTokenRepository,
} from './email-verification-token.repository'

export interface DatosRegistro {
  email: string
  password: string
  fullName: string
}

@Injectable()
export class RegisterUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
    @Inject(EMAIL_VERIFICATION_TOKEN_REPOSITORY) private readonly tokens: EmailVerificationTokenRepository,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async ejecutar(datos: DatosRegistro): Promise<{ id: string; email: string; fullName: string }> {
    const email = datos.email.trim().toLowerCase()

    // Igualación de tiempos: llamar hasher.hash() siempre, independientemente
    // de la rama (nuevo usuario o existente). Mismo principio que el hash
    // señuelo de LoginUseCase: la respuesta tarda lo mismo en ambos casos.
    const passwordHash = await this.hasher.hash(datos.password)

    // ¿Email ya registrado?
    const existente = await this.usuarios.findByEmail(email)

    if (existente === null) {
      // Rama 1: usuario nuevo. Crear, generar token, encolar verificación.
      let usuario: User
      try {
        usuario = await this.usuarios.create({
          email,
          passwordHash,
          fullName: datos.fullName,
        })
      } catch (error) {
        // Carrera: otro registro concurrente ganó entre el findByEmail
        // y el create. Tratar como "existente" en vez de dejar subir el 409.
        if (error instanceof EmailYaRegistradoError) {
          return await this.notificarExistente(email)
        }
        throw error
      }

      // Generar token, persistir hash, encolar correo de verificación.
      const tokenEnClaro = generarTokenVerificacion()
      const tokenHash = hashToken(tokenEnClaro)
      const { id: tokenId } = await this.tokens.crear({
        userId: usuario.id,
        tokenHash,
        expiresAt: caducidadVerificacion(this.env.EMAIL_VERIFICATION_TTL_HOURS),
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
        // Por token y no por usuario: ver el comentario de EmailProcessor. Con el id
        // del usuario, un reenvío chocaría con el jobId del registro original.
        { jobId: `verify-email-${tokenId}`, removeOnComplete: true },
      )

      return { id: usuario.id, email: usuario.email, fullName: usuario.fullName }
    }

    // Rama 2: email ya registrado. Encolar aviso, devolver la MISMA forma que rama 1.
    return await this.notificarExistente(email)
  }

  private async notificarExistente(email: string): Promise<{ id: string; email: string; fullName: string }> {
    const usuario = await this.usuarios.findByEmail(email)
    if (usuario === null) {
      // Edge case: se borró entre el primer findByEmail y aquí (muy improbable).
      // Devolver valores plausibles en la misma forma.
      return { id: 'unknown', email, fullName: 'Unknown' }
    }

    // Encolar aviso de intento de registro (sin token, sin enlace).
    await this.cola.enqueue(
      'email',
      'send-registration-notice',
      {
        userId: usuario.id,
        email: usuario.email,
        fullName: usuario.fullName,
      },
      { jobId: `registration-notice-${usuario.id}`, removeOnComplete: true },
    )

    // Devolver exactamente la misma forma que la rama "usuario nuevo",
    // sin revelar si el email ya existía.
    return { id: usuario.id, email: usuario.email, fullName: usuario.fullName }
  }
}
