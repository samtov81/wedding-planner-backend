import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import { NotificationWriterModule } from '@/modules/notifications/notification-writer.module'
import { UsersModule } from '@/modules/users/users.module'

import { CreateScheduleItemUseCase } from './application/create-schedule-item.use-case'
import { DeleteScheduleItemUseCase } from './application/delete-schedule-item.use-case'
import { ListScheduleItemsUseCase } from './application/list-schedule-items.use-case'
import {
  AsignarProveedoresUseCase,
  AvisarProveedoresUseCase,
  ConfirmacionesUseCase,
  CrearNotaUseCase,
  ListarAsignablesUseCase,
  ListarNotasUseCase,
} from './application/participacion.use-cases'
import { SCHEDULE_ITEM_REPOSITORY } from './application/schedule-item.repository'
import { UpdateScheduleItemUseCase } from './application/update-schedule-item.use-case'
import { PrismaScheduleItemRepository } from './infrastructure/prisma-schedule-item.repository'
import { ScheduleController } from './interfaces/schedule.controller'

/**
 * `EventsModule` se importa por el mismo motivo que en `VendorsModule`:
 * `EventAccessGuard` y `RequireEventAccess` son el único punto de
 * autorización sobre eventos. `UsersModule` porque `JwtAuthGuard` necesita
 * `USER_REPOSITORY`, que sólo expone ese módulo.
 *
 * `NotificationWriterModule` aporta `NOTIFICATION_PORT`: las campanas del
 * cronograma (`schedule.item.rescheduled`, `schedule.confirmation.requested`)
 * se crean dentro de la transacción del caso de uso. Se importa éste y no
 * `NotificationsModule` porque aquí sólo hace falta escribir, como en
 * `VendorsModule`.
 *
 * `UNIDAD_DE_TRABAJO` y `QUEUE_PORT` llegan de `DatabaseModule` y
 * `QueueModule`, que son globales: se cablean igual que en `VendorsModule` y
 * `MoodboardModule`, sin declararlos aquí. La cola `schedule` sólo necesita
 * `registerQueue` cuando haya un worker que montar sobre ella (Task 6);
 * encolar va por `QUEUE_PORT`, que crea la cola bajo demanda.
 */
@Module({
  imports: [AuthModule, UsersModule, EventsModule, NotificationWriterModule],
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
    AsignarProveedoresUseCase,
    ListarAsignablesUseCase,
    ListarNotasUseCase,
    CrearNotaUseCase,
    ConfirmacionesUseCase,
    AvisarProveedoresUseCase,
  ],
})
export class ScheduleModule {}
