import { Module } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import {
  INVITATION_RENDERER,
  type InvitationRenderer,
} from './application/invitation-renderer.port'
import {
  EMAIL_VERIFICATION_RENDERER,
  type EmailVerificationRenderer,
} from './application/email-verification-renderer.port'
import {
  REGISTRATION_NOTICE_RENDERER,
  type RegistrationNoticeRenderer,
} from './application/registration-notice-renderer.port'
import {
  PASSWORD_RESET_RENDERER,
  type PasswordResetRenderer,
} from './application/password-reset-renderer.port'
import {
  PASSWORD_CHANGED_RENDERER,
  type PasswordChangedRenderer,
} from './application/password-changed-renderer.port'
import { MAIL_PORT, type MailPort } from './application/mail.port'
import { FakeMailAdapter } from './infrastructure/mail.adapter.fake'
import { ResendMailAdapter } from './infrastructure/resend-mail.adapter'
import { renderGuestInvitation } from './infrastructure/templates/guest-invitation'
import { renderEmailVerification } from './infrastructure/templates/email-verification'
import { renderRegistrationAttemptNotice } from './infrastructure/templates/registration-attempt-notice'
import { renderPasswordReset } from './infrastructure/templates/password-reset'
import { renderPasswordChanged } from './infrastructure/templates/password-changed'

@Module({
  providers: [
    {
      provide: MAIL_PORT,
      inject: [ENV],
      useFactory: (env: Env): MailPort =>
        env.MAIL_DRIVER === 'resend' ? new ResendMailAdapter(env) : new FakeMailAdapter(),
    },
    {
      // La plantilla se publica como puerto para que el worker de invitaciones
      // (Tarea 12) no importe `infrastructure/` de este módulo.
      provide: INVITATION_RENDERER,
      useValue: { render: renderGuestInvitation } satisfies InvitationRenderer,
    },
    {
      provide: EMAIL_VERIFICATION_RENDERER,
      useValue: { render: renderEmailVerification } satisfies EmailVerificationRenderer,
    },
    {
      provide: REGISTRATION_NOTICE_RENDERER,
      useValue: { render: renderRegistrationAttemptNotice } satisfies RegistrationNoticeRenderer,
    },
    {
      provide: PASSWORD_RESET_RENDERER,
      useValue: { render: renderPasswordReset } satisfies PasswordResetRenderer,
    },
    {
      provide: PASSWORD_CHANGED_RENDERER,
      useValue: { render: renderPasswordChanged } satisfies PasswordChangedRenderer,
    },
  ],
  exports: [
    MAIL_PORT,
    INVITATION_RENDERER,
    EMAIL_VERIFICATION_RENDERER,
    REGISTRATION_NOTICE_RENDERER,
    PASSWORD_RESET_RENDERER,
    PASSWORD_CHANGED_RENDERER,
  ],
})
export class MailModule {}
