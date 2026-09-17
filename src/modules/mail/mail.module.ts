import { Module } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import { MAIL_PORT, type MailPort } from './application/mail.port'
import { FakeMailAdapter } from './infrastructure/fake-mail.adapter'
import { ResendMailAdapter } from './infrastructure/resend-mail.adapter'

@Module({
  providers: [
    {
      provide: MAIL_PORT,
      inject: [ENV],
      useFactory: (env: Env): MailPort =>
        env.MAIL_DRIVER === 'resend' ? new ResendMailAdapter(env) : new FakeMailAdapter(),
    },
  ],
  exports: [MAIL_PORT],
})
export class MailModule {}
