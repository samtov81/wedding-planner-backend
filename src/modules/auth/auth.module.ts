import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'

import { PrismaService } from '@/modules/database/prisma.service'
import { UsersModule } from '@/modules/users/users.module'
import { MailModule } from '@/modules/mail/mail.module'

import { LoginUseCase } from './application/login.use-case'
import { LogoutUseCase } from './application/logout.use-case'
import { RefreshUseCase } from './application/refresh.use-case'
import { RegisterUseCase } from './application/register.use-case'
import { ResendVerificationUseCase } from './application/resend-verification.use-case'
import { VerifyEmailUseCase } from './application/verify-email.use-case'
import { SESSION_REPOSITORY } from './application/session.repository'
import { TokenService } from './application/token.service'
import { EMAIL_VERIFICATION_TOKEN_REPOSITORY } from './application/email-verification-token.repository'
import { PrismaSessionRepository } from './infrastructure/prisma-session.repository'
import { PrismaEmailVerificationTokenRepository } from './infrastructure/prisma-email-verification-token.repository'
import { AuthController } from './interfaces/auth.controller'
import { JwtAuthGuard } from './interfaces/jwt-auth.guard'
import { EmailProcessor } from './interfaces/email.processor'

@Module({
  imports: [UsersModule, MailModule, BullModule.registerQueue({ name: 'email' })],
  controllers: [AuthController],
  providers: [
    TokenService,
    JwtAuthGuard,
    {
      provide: SESSION_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaSessionRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: EMAIL_VERIFICATION_TOKEN_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaEmailVerificationTokenRepository(prisma),
      inject: [PrismaService],
    },
    RegisterUseCase,
    LoginUseCase,
    RefreshUseCase,
    LogoutUseCase,
    VerifyEmailUseCase,
    ResendVerificationUseCase,
    EmailProcessor,
  ],
  exports: [TokenService, JwtAuthGuard],
})
export class AuthModule {}
