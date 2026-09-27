import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import { UsersModule } from '@/modules/users/users.module'

import { CreateScheduleItemUseCase } from './application/create-schedule-item.use-case'
import { DeleteScheduleItemUseCase } from './application/delete-schedule-item.use-case'
import { ListScheduleItemsUseCase } from './application/list-schedule-items.use-case'
import { SCHEDULE_ITEM_REPOSITORY } from './application/schedule-item.repository'
import { UpdateScheduleItemUseCase } from './application/update-schedule-item.use-case'
import { PrismaScheduleItemRepository } from './infrastructure/prisma-schedule-item.repository'
import { ScheduleController } from './interfaces/schedule.controller'

/**
 * `EventsModule` se importa por el mismo motivo que en `VendorsModule`:
 * `EventAccessGuard` y `RequireEventAccess` son el único punto de
 * autorización sobre eventos. `UsersModule` porque `JwtAuthGuard` necesita
 * `USER_REPOSITORY`, que sólo expone ese módulo.
 */
@Module({
  imports: [AuthModule, UsersModule, EventsModule],
  controllers: [ScheduleController],
  providers: [
    {
      provide: SCHEDULE_ITEM_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaScheduleItemRepository(prisma),
      inject: [PrismaService],
    },
    ListScheduleItemsUseCase,
    CreateScheduleItemUseCase,
    UpdateScheduleItemUseCase,
    DeleteScheduleItemUseCase,
  ],
})
export class ScheduleModule {}
