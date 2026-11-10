import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import {
  NOTIFICATION_PORT,
  type NotificationPort,
} from '@/modules/notifications/application/notification.port'
import { REALTIME_PORT, type RealtimePort } from '@/modules/notifications/application/realtime.port'
import { NotificationsModule } from '@/modules/notifications/notifications.module'
import { StorageModule } from '@/modules/storage/storage.module'
import { UsersModule } from '@/modules/users/users.module'

import { COLA_CRONOGRAMA } from './application/avisos-cronograma'
import { CreateScheduleItemUseCase } from './application/create-schedule-item.use-case'
import { DeleteScheduleItemUseCase } from './application/delete-schedule-item.use-case'
import { DescargarPdfUseCase } from './application/descargar-pdf.use-case'
import { ListScheduleItemsUseCase } from './application/list-schedule-items.use-case'
import {
  AsignarProveedoresUseCase,
  AvisarProveedoresUseCase,
  ConfirmacionesUseCase,
  CrearNotaUseCase,
  ListarAsignablesUseCase,
  ListarNotasUseCase,
} from './application/participacion.use-cases'
import { GENERADOR_PDF } from './application/pdf.port'
import {
  SCHEDULE_ITEM_REPOSITORY,
  type ScheduleItemRepository,
} from './application/schedule-item.repository'
import { UpdateScheduleItemUseCase } from './application/update-schedule-item.use-case'
import { PdfkitCronograma } from './infrastructure/pdfkit-cronograma'
import { PrismaScheduleItemRepository } from './infrastructure/prisma-schedule-item.repository'
import { ScheduleController } from './interfaces/schedule.controller'
import { ScheduleProcessor } from './interfaces/schedule.processor'
import { ScheduleRemindersModule } from './schedule-reminders.module'

/**
 * `EventsModule` se importa por el mismo motivo que en `VendorsModule`:
 * `EventAccessGuard` y `RequireEventAccess` son el único punto de
 * autorización sobre eventos. `UsersModule` porque `JwtAuthGuard` necesita
 * `USER_REPOSITORY`, que sólo expone ese módulo.
 *
 * `NotificationsModule` aporta `NOTIFICATION_PORT` (las campanas del
 * cronograma se crean dentro de la transacción del caso de uso, y el
 * recordatorio la crea el worker) y `REALTIME_PORT` (el worker empuja
 * `notification.created`). Se importa éste y no `NotificationWriterModule`
 * porque el worker necesita los dos puertos, como en `MoodboardModule`.
 *
 * `registerQueue('schedule')`: el explorador de `@nestjs/bullmq` necesita la
 * cola registrada en el módulo para montar `ScheduleProcessor` (Task 6). El
 * worker se cablea con `useFactory` para que su `reloj` quede en el valor por
 * defecto (ver su docblock).
 *
 * `StorageModule` aporta `SubidaDeImagenes`: el controlador firma los
 * avatares de notas y de "Vendors Ready" al responder, como el moodboard.
 *
 * `ScheduleRemindersModule` (el que exporta `RECORDATORIOS_PORT` a `vendors`)
 * se importa para que el cronograma tenga a mano su propio puerto público;
 * hoy ningún proveedor de aquí lo inyecta, porque los casos de uso encolan
 * con `encolarRecordatorios` directamente.
 *
 * `UNIDAD_DE_TRABAJO` y `QUEUE_PORT` llegan de `DatabaseModule` y
 * `QueueModule`, que son globales: se cablean igual que en `VendorsModule` y
 * `MoodboardModule`, sin declararlos aquí.
 */
@Module({
  imports: [
    AuthModule,
    UsersModule,
    EventsModule,
    NotificationsModule,
    StorageModule,
    ScheduleRemindersModule,
    BullModule.registerQueue({ name: COLA_CRONOGRAMA }),
  ],
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
    DescargarPdfUseCase,
    // `useFactory`: el generador no es inyectable por clase (puerto, no adaptador).
    { provide: GENERADOR_PDF, useFactory: () => new PdfkitCronograma() },
    {
      provide: ScheduleProcessor,
      useFactory: (
        items: ScheduleItemRepository,
        notificaciones: NotificationPort,
        tiempoReal: RealtimePort,
      ) => new ScheduleProcessor(items, notificaciones, tiempoReal),
      inject: [SCHEDULE_ITEM_REPOSITORY, NOTIFICATION_PORT, REALTIME_PORT],
    },
  ],
})
export class ScheduleModule {}
