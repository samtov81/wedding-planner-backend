import { Module } from '@nestjs/common'

import { PrismaService } from '@/modules/database/prisma.service'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { ProgramarRecordatorios } from './application/programar-recordatorios'
import { RECORDATORIOS_PORT } from './application/recordatorios.port'
import { PrismaScheduleItemRepository } from './infrastructure/prisma-schedule-item.repository'

/**
 * Sólo el puerto `RECORDATORIOS_PORT`, para `vendors` (spec 2026-11-10 §5,
 * "Recontratación"). Mismo patrón que `NotificationWriterModule`: un módulo
 * de cableado que NO importa ningún otro módulo, así que cualquiera puede
 * importarlo sin cerrar un ciclo. `PrismaService` y `QUEUE_PORT` llegan de
 * `DatabaseModule` y `QueueModule`, que son globales.
 *
 * Por qué no exportar el puerto desde `ScheduleModule`: éste importa
 * `EventsModule`, `NotificationsModule`… y monta controlador y worker; que
 * `VendorsModule` lo importara arrastraría todo eso y, el día que el
 * cronograma necesite algo de `vendors`, sería un ciclo de módulos.
 *
 * Construye su propio `PrismaScheduleItemRepository` (no exportado): el
 * adaptador no tiene estado, así que es equivalente al de `ScheduleModule`.
 */
@Module({
  providers: [
    {
      provide: RECORDATORIOS_PORT,
      useFactory: (prisma: PrismaService, cola: QueuePort) =>
        new ProgramarRecordatorios(new PrismaScheduleItemRepository(prisma), cola),
      inject: [PrismaService, QUEUE_PORT],
    },
  ],
  exports: [RECORDATORIOS_PORT],
})
export class ScheduleRemindersModule {}
