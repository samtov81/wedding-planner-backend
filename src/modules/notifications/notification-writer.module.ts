import { Module } from '@nestjs/common'

import { PrismaService } from '@/modules/database/prisma.service'

import { NOTIFICATION_PORT } from './application/notification.port'
import { PrismaNotificationRepository } from './infrastructure/prisma-notification.repository'

/**
 * Sólo el puerto de ESCRITURA de notificaciones, para quien necesita crearlas
 * dentro de su propia transacción (`events`: aceptar o rechazar una invitación
 * de equipo avisa al dueño).
 *
 * Por qué no importar `NotificationsModule` desde `EventsModule`:
 * `NotificationsModule` importa `EventsModule` (necesita `EventAccessGuard` y
 * `EventAccessService` para sus controladores y el gateway), así que la
 * importación inversa sería un ciclo de módulos de Nest. Este módulo rompe el
 * ciclo por construcción: NO importa ningún otro módulo (`PrismaService` llega
 * del `DatabaseModule`, que es global) y por eso cualquiera puede importarlo.
 *
 * Alternativa descartada: partir `EventsModule` en dos. Mucho más invasivo que
 * un módulo de una línea de cableado, y no resolvería que el puerto viva en
 * `notifications`.
 *
 * `NotificationsModule` sigue construyendo su propia instancia (la misma que su
 * `NOTIFICATION_REPOSITORY`, de lectura): el adaptador no tiene estado, así que
 * dos instancias son equivalentes.
 */
@Module({
  providers: [
    {
      provide: NOTIFICATION_PORT,
      useFactory: (prisma: PrismaService) => new PrismaNotificationRepository(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [NOTIFICATION_PORT],
})
export class NotificationWriterModule {}
