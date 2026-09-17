import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { UsersModule } from '@/modules/users/users.module'

import { CreateEventUseCase } from './application/create-event.use-case'
import { EventAccessService } from './application/event-access.service'
import { EVENT_REPOSITORY } from './application/event.repository'
import { InviteMemberUseCase } from './application/invite-member.use-case'
import { ListEventsUseCase } from './application/list-events.use-case'
import { PrismaEventRepository } from './infrastructure/prisma-event.repository'
import { EventAccessGuard } from './interfaces/event-access.guard'
import { EventsController } from './interfaces/events.controller'

/**
 * `AuthModule` se IMPORTA (no se re-provee `JwtAuthGuard`): desde la Tarea 8 el
 * guard inyecta `UserRepository` para recargar al usuario, así que sólo sirve
 * el que construye su propio módulo.
 *
 * `EventAccessService` y `EVENT_REPOSITORY` se exportan porque las Tareas 10,
 * 11 y 14 (invitados, RSVP y el gateway de sockets) autorizan a través de
 * ellos: ése es justamente el punto de tener un único sitio donde se decide.
 */
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [EventsController],
  providers: [
    {
      provide: EVENT_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaEventRepository(prisma),
      inject: [PrismaService],
    },
    EventAccessService,
    EventAccessGuard,
    CreateEventUseCase,
    ListEventsUseCase,
    InviteMemberUseCase,
  ],
  exports: [EventAccessService, EVENT_REPOSITORY],
})
export class EventsModule {}
