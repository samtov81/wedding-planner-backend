import { Module } from '@nestjs/common'

import { PrismaService } from '@/modules/database/prisma.service'

import { PASSWORD_HASHER } from './application/password-hasher.port'
import { USER_REPOSITORY } from './application/user.repository'
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher'
import { PrismaUserRepository } from './infrastructure/prisma-user.repository'

@Module({
  providers: [
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    {
      provide: USER_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaUserRepository(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [PASSWORD_HASHER, USER_REPOSITORY],
})
export class UsersModule {}
