import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import { NotificationsModule } from '@/modules/notifications/notifications.module'
import { StorageModule } from '@/modules/storage/storage.module'
import { UsersModule } from '@/modules/users/users.module'

import { COLA_MOODBOARD } from './application/avisos-moodboard'
import { MOODBOARD_REPOSITORY } from './application/moodboard.repository'
import {
  ArchivarImagenUseCase,
  CompartirImagenUseCase,
  CrearImagenUseCase,
  CrearNotaUseCase,
  ListarCompartiblesUseCase,
  ListarImagenesUseCase,
  ListarNotasUseCase,
  ObtenerImagenUseCase,
  PrepararSubidaUseCase,
  ResumenUseCase,
} from './application/moodboard.use-cases'
import { PrismaMoodboardRepository } from './infrastructure/prisma-moodboard.repository'
import { MoodboardController } from './interfaces/moodboard.controller'
import { MoodboardProcessor } from './interfaces/moodboard.processor'

/**
 * Moodboard del evento (spec 2026-11-09).
 *
 *  - `AuthModule` + `UsersModule`: `JwtAuthGuard` necesita `TokenService` y
 *    `USER_REPOSITORY`, como en el resto del REST.
 *  - `EventsModule`: `EventAccessGuard` y `RequireEventAccess`, el único punto
 *    de autorización sobre eventos.
 *  - `NotificationsModule`: `NOTIFICATION_PORT` (campanas dentro de la
 *    transacción), `REALTIME_PORT` (el worker emite al socket) y
 *    `PRESENCE_PORT` (quién está en línea en el resumen). Se importa éste y no
 *    `NotificationWriterModule` porque hacen falta los tres puertos.
 *  - `StorageModule`: `SubidaDeImagenes` (subida directa a R2 y URLs firmadas).
 *  - `registerQueue('moodboard')`: el explorador de `@nestjs/bullmq` necesita la
 *    cola registrada en el módulo para montar `MoodboardProcessor` sobre ella.
 *
 * `UNIDAD_DE_TRABAJO` y `QUEUE_PORT` llegan de `DatabaseModule` y `QueueModule`,
 * que son globales.
 */
@Module({
  imports: [
    AuthModule,
    UsersModule,
    EventsModule,
    NotificationsModule,
    StorageModule,
    BullModule.registerQueue({ name: COLA_MOODBOARD }),
  ],
  controllers: [MoodboardController],
  providers: [
    {
      provide: MOODBOARD_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaMoodboardRepository(prisma),
      inject: [PrismaService],
    },
    PrepararSubidaUseCase,
    CrearImagenUseCase,
    ListarImagenesUseCase,
    ObtenerImagenUseCase,
    ArchivarImagenUseCase,
    CompartirImagenUseCase,
    ListarCompartiblesUseCase,
    ListarNotasUseCase,
    CrearNotaUseCase,
    ResumenUseCase,
    MoodboardProcessor,
  ],
})
export class MoodboardModule {}
