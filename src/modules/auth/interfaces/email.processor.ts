import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import { z } from 'zod'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { EMAIL_VERIFICATION_RENDERER, type EmailVerificationRenderer } from '@/modules/mail/application/email-verification-renderer.port'
import { MAIL_PORT, type MailPort } from '@/modules/mail/application/mail.port'
import { PASSWORD_CHANGED_RENDERER, type PasswordChangedRenderer } from '@/modules/mail/application/password-changed-renderer.port'
import { PASSWORD_RESET_RENDERER, type PasswordResetRenderer } from '@/modules/mail/application/password-reset-renderer.port'
import { REGISTRATION_NOTICE_RENDERER, type RegistrationNoticeRenderer } from '@/modules/mail/application/registration-notice-renderer.port'

const payloadVerificacionSchema = z.object({
  userId: z.string().min(1),
  tokenId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
  token: z.string().min(1),
})

const payloadAvisoSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
})

const payloadResetSchema = z.object({
  userId: z.string().min(1),
  tokenId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
  token: z.string().min(1),
})

const payloadCambioSchema = z.object({
  userId: z.string().min(1),
  tokenId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
  // Hora de la transacción que cambió la contraseña, no de cuando este worker
  // la procese (ver `ResetPasswordUseCase.avisarDelCambio`).
  cambiadoEn: z.iso.datetime(),
})

@Processor('email')
export class EmailProcessor extends WorkerHost {
  constructor(
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(ENV) private readonly env: Env,
    @Inject(EMAIL_VERIFICATION_RENDERER) private readonly plantillaVerificacion: EmailVerificationRenderer,
    @Inject(REGISTRATION_NOTICE_RENDERER) private readonly plantillaAviso: RegistrationNoticeRenderer,
    @Inject(PASSWORD_RESET_RENDERER) private readonly plantillaReset: PasswordResetRenderer,
    @Inject(PASSWORD_CHANGED_RENDERER) private readonly plantillaCambio: PasswordChangedRenderer,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'send-verification-email') return await this.enviarVerificacion(job)
    if (job.name === 'send-registration-notice') return await this.enviarAviso(job)
    if (job.name === 'send-password-reset-email') return await this.enviarReset(job)
    if (job.name === 'send-password-changed-notice') return await this.enviarAvisoCambio(job)

    // Nombre de job desconocido: bug o versión futura del productor.
    // UnrecoverableError previene reintentos.
    throw new UnrecoverableError(`Job de tipo desconocido en la cola 'email': ${job.name}`)
  }

  private async enviarVerificacion(job: Job): Promise<void> {
    const leido = payloadVerificacionSchema.safeParse(job.data)
    if (!leido.success) throw new UnrecoverableError('Payload de verificación inválido')

    const { email, fullName, token, userId, tokenId } = leido.data
    const { html, text } = await this.plantillaVerificacion.render({
      fullName,
      verifyUrl: `${this.env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`,
    })

    await this.mail.send({
      to: email,
      subject: 'Verify your email address',
      html,
      text,
      tags: { userId },
      // La clave lleva el TOKEN, no el usuario: con el id del usuario, el segundo
      // correo de verificación del mismo usuario (un reenvío) choca con la clave
      // del primero y Resend lo descarta como duplicado — cuenta como enviado sin
      // salir. Por token, la idempotencia sigue siendo la real (un token, un
      // correo, reintentos de BullMQ incluidos) y cada reenvío sale.
      idempotencyKey: `verify-email-${tokenId}`,
    })
  }

  private async enviarAviso(job: Job): Promise<void> {
    const leido = payloadAvisoSchema.safeParse(job.data)
    if (!leido.success) throw new UnrecoverableError('Payload de aviso inválido')

    const { email, fullName, userId } = leido.data
    const { html, text } = await this.plantillaAviso.render({ fullName })

    await this.mail.send({
      to: email,
      subject: 'Someone tried to register with your email',
      html,
      text,
      tags: { userId },
      idempotencyKey: `registration-notice-${userId}`,
    })
  }

  private async enviarReset(job: Job): Promise<void> {
    const leido = payloadResetSchema.safeParse(job.data)
    if (!leido.success) throw new UnrecoverableError('Payload de recuperación inválido')

    const { email, fullName, token, userId, tokenId } = leido.data
    const { html, text } = await this.plantillaReset.render({
      fullName,
      resetUrl: `${this.env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`,
      minutosDeValidez: this.env.PASSWORD_RESET_TTL_MINUTES,
    })

    await this.mail.send({
      to: email,
      subject: 'Reset your password',
      html,
      text,
      tags: { userId },
      // Por token, igual que la verificación: cada petición nueva sale.
      idempotencyKey: `password-reset-${tokenId}`,
    })
  }

  private async enviarAvisoCambio(job: Job): Promise<void> {
    const leido = payloadCambioSchema.safeParse(job.data)
    if (!leido.success) throw new UnrecoverableError('Payload de aviso de cambio inválido')

    const { email, fullName, userId, tokenId, cambiadoEn } = leido.data
    const { html, text } = await this.plantillaCambio.render({
      fullName,
      // Momento del cambio (payload), no el del proceso: la cola puede tardar
      // segundos en llegar a este job.
      cambiadoEn: new Date(cambiadoEn),
      recoverUrl: `${this.env.APP_URL}/forgot-password`,
    })

    await this.mail.send({
      to: email,
      subject: 'Your password was changed',
      html,
      text,
      tags: { userId },
      idempotencyKey: `password-changed-${tokenId}`,
    })
  }
}
