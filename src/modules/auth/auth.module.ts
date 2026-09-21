import { Module } from '@nestjs/common'

import { PrismaService } from '@/modules/database/prisma.service'
import { UsersModule } from '@/modules/users/users.module'

import { LoginUseCase } from './application/login.use-case'
import { LogoutUseCase } from './application/logout.use-case'
import { RefreshUseCase } from './application/refresh.use-case'
import { RegisterUseCase } from './application/register.use-case'
import { SESSION_REPOSITORY } from './application/session.repository'
import { TokenService } from './application/token.service'
import { PrismaSessionRepository } from './infrastructure/prisma-session.repository'
import { AuthController } from './interfaces/auth.controller'
import { JwtAuthGuard } from './interfaces/jwt-auth.guard'

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    TokenService,
    JwtAuthGuard,
    {
      provide: SESSION_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaSessionRepository(prisma),
      inject: [PrismaService],
    },
    RegisterUseCase,
    LoginUseCase,
    RefreshUseCase,
    LogoutUseCase,
  ],
  exports: [TokenService, JwtAuthGuard],
})
export class AuthModule {}
