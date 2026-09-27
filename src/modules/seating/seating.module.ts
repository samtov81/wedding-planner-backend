import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import { UsersModule } from '@/modules/users/users.module'

import { AssignSeatUseCase } from './application/assign-seat.use-case'
import { ClearSeatUseCase } from './application/clear-seat.use-case'
import { CreateTableUseCase } from './application/create-table.use-case'
import { DeleteTableUseCase } from './application/delete-table.use-case'
import { GenerateTablesUseCase } from './application/generate-tables.use-case'
import { GetSeatingUseCase } from './application/get-seating.use-case'
import { SEATING_REPOSITORY } from './application/seating.repository'
import { UpdateTableUseCase } from './application/update-table.use-case'
import { PrismaSeatingRepository } from './infrastructure/prisma-seating.repository'
import { SeatingController } from './interfaces/seating.controller'

/**
 * Mismos imports que `ScheduleModule`: `EventsModule` por `EventAccessGuard`
 * y `UsersModule` porque `JwtAuthGuard` necesita `USER_REPOSITORY`. Los
 * invitados se leen por el puerto propio (`buscarInvitado`, `listarInvitados`),
 * como hace expenses con los proveedores, sin tocar el módulo de guests.
 * `UNIDAD_DE_TRABAJO` llega del `DatabaseModule` global.
 */
@Module({
  imports: [AuthModule, UsersModule, EventsModule],
  controllers: [SeatingController],
  providers: [
    {
      provide: SEATING_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaSeatingRepository(prisma),
      inject: [PrismaService],
    },
    GetSeatingUseCase,
    GenerateTablesUseCase,
    CreateTableUseCase,
    UpdateTableUseCase,
    DeleteTableUseCase,
    AssignSeatUseCase,
    ClearSeatUseCase,
  ],
})
export class SeatingModule {}
