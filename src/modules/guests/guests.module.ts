import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import { UsersModule } from '@/modules/users/users.module'

import { CreateGuestUseCase } from './application/create-guest.use-case'
import { DeleteGuestUseCase } from './application/delete-guest.use-case'
import { GetGuestUseCase } from './application/get-guest.use-case'
import { GUEST_REPOSITORY } from './application/guest.repository'
import { GuestSummaryUseCase } from './application/guest-summary.use-case'
import { ListGuestsUseCase } from './application/list-guests.use-case'
import { UpdateGuestUseCase } from './application/update-guest.use-case'
import { PrismaGuestRepository } from './infrastructure/prisma-guest.repository'
import { GuestsController } from './interfaces/guests.controller'

/**
 * `EventsModule` se IMPORTA para consumir `EventAccessGuard` tal cual: es el
 * punto ÚNICO de autorización sobre eventos y reconstruirlo aquí sería una
 * copia que puede divergir. `AuthModule` + `UsersModule` por el mismo motivo
 * que en `VendorsModule`: `JwtAuthGuard` inyecta `USER_REPOSITORY`.
 *
 * `GUEST_REPOSITORY` se EXPORTA: el envío masivo de invitaciones (Tarea 12)
 * consume `listarTodos` a través del puerto, sin tocar este `infrastructure/`.
 */
@Module({
  imports: [AuthModule, UsersModule, EventsModule],
  controllers: [GuestsController],
  providers: [
    {
      provide: GUEST_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaGuestRepository(prisma),
      inject: [PrismaService],
    },
    ListGuestsUseCase,
    GetGuestUseCase,
    GuestSummaryUseCase,
    CreateGuestUseCase,
    UpdateGuestUseCase,
    DeleteGuestUseCase,
  ],
  exports: [GUEST_REPOSITORY],
})
export class GuestsModule {}
