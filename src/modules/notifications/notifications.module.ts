import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import { UsersModule } from '@/modules/users/users.module'

import { BroadcastNoticeUseCase } from './application/broadcast-notice.use-case'
import { ListNotificationsUseCase } from './application/list-notifications.use-case'
import { MarkReadUseCase } from './application/mark-read.use-case'
import { NOTIFICATION_PORT } from './application/notification.port'
import { NOTIFICATION_REPOSITORY } from './application/notification.repository'
import { REALTIME_PORT } from './application/realtime.port'
import { PrismaNotificationRepository } from './infrastructure/prisma-notification.repository'
import { SocketIoRealtimeAdapter } from './infrastructure/socketio-realtime.adapter'
import { COLA_NOTIFICACIONES, NotificationProcessor } from './interfaces/notification.processor'
import { NotificationsController } from './interfaces/notifications.controller'
import { NotificationsGateway } from './interfaces/notifications.gateway'

/**
 * Notificaciones persistidas y tiempo real (Tarea 15).
 *
 * Los dos puertos que la Tarea 14 definió se cablean con sus adaptadores
 * REALES; los dobles en memoria quedan sólo para tests:
 *  - `NOTIFICATION_PORT` → `PrismaNotificationRepository`, la MISMA instancia
 *    que `NOTIFICATION_REPOSITORY` (`useExisting`): crear y leer son dos
 *    puertos de un único adaptador.
 *  - `REALTIME_PORT` → `SocketIoRealtimeAdapter` (Redis emitter).
 *
 * `AuthModule` + `UsersModule` + `EventsModule` se IMPORTAN para que el gateway
 * y el controlador autoricen con el mismo `TokenService`, `USER_REPOSITORY`,
 * `EventAccessService` y `EventAccessGuard` que el resto del REST, no con
 * copias.
 *
 * `registerQueue('notifications')`: el explorador de `@nestjs/bullmq` necesita
 * la cola registrada en este módulo para montar `NotificationProcessor`.
 */
@Module({
  imports: [
    AuthModule,
    UsersModule,
    EventsModule,
    BullModule.registerQueue({ name: COLA_NOTIFICACIONES }),
  ],
  controllers: [NotificationsController],
  providers: [
    {
      provide: NOTIFICATION_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaNotificationRepository(prisma),
      inject: [PrismaService],
    },
    { provide: NOTIFICATION_PORT, useExisting: NOTIFICATION_REPOSITORY },
    {
      provide: REALTIME_PORT,
      useFactory: (env: Env) => new SocketIoRealtimeAdapter(env.REDIS_URL),
      inject: [ENV],
    },
    ListNotificationsUseCase,
    MarkReadUseCase,
    BroadcastNoticeUseCase,
    NotificationProcessor,
    NotificationsGateway,
  ],
  exports: [NOTIFICATION_PORT, REALTIME_PORT],
})
export class NotificationsModule {}
