import { Module } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import {
  INVITATION_RENDERER,
  type InvitationRenderer,
} from './application/invitation-renderer.port'
import { MAIL_PORT, type MailPort } from './application/mail.port'
import { FakeMailAdapter } from './infrastructure/fake-mail.adapter'
import { ResendMailAdapter } from './infrastructure/resend-mail.adapter'
import { renderGuestInvitation } from './infrastructure/templates/guest-invitation'

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
  ],
  exports: [MAIL_PORT, INVITATION_RENDERER],
})
export class MailModule {}
