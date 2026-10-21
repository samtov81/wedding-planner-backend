import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { MailModule } from '@/modules/mail/mail.module'
import { UsersModule } from '@/modules/users/users.module'

import { CreateEventUseCase } from './application/create-event.use-case'
import { EventAccessService } from './application/event-access.service'
import { EVENT_REPOSITORY } from './application/event.repository'
import { COLA_MIEMBROS, InviteMemberUseCase } from './application/invite-member.use-case'
import { ListEventsUseCase } from './application/list-events.use-case'
import {
  AcceptInvitationUseCase,
  DeclineInvitationUseCase,
  ListMembersUseCase,
  ListMyInvitationsUseCase,
  RevokeMemberUseCase,
  UpdateMemberUseCase,
} from './application/members.use-cases'
import { PublishEventUseCase } from './application/publish-event.use-case'
import { UpdateEventUseCase } from './application/update-event.use-case'
import { PrismaEventRepository } from './infrastructure/prisma-event.repository'
import { EventAccessGuard } from './interfaces/event-access.guard'
import { EventsController } from './interfaces/events.controller'
import { MemberInvitationProcessor } from './interfaces/member-invitation.processor'
import { MembersController } from './interfaces/members.controller'
import { MyInvitationsController } from './interfaces/my-invitations.controller'

/**
 * `AuthModule` se IMPORTA (no se re-provee `JwtAuthGuard`): desde la Tarea 8 el
 * guard inyecta `UserRepository` para recargar al usuario, así que sólo sirve
 * el que construye su propio módulo.
 *
 * `EventAccessService` y `EVENT_REPOSITORY` se exportan porque las Tareas 10,
 * 11 y 14 (invitados, RSVP y el gateway de sockets) autorizan a través de
 * ellos: ése es justamente el punto de tener un único sitio donde se decide.
 *
 * `EventAccessGuard` se exporta también (Tarea 10): un módulo que usa
 * `@UseGuards(EventAccessGuard)` necesita poder resolverlo en su propio
 * injector, y el guard no tiene sentido reconstruido en otro módulo — es el
 * mismo punto único de autorización, no una copia.
 */
@Module({
  imports: [
    AuthModule,
    UsersModule,
    MailModule,
    // Sin este `registerQueue`, `MemberInvitationProcessor` no arranca
    // (NO_QUEUE_FOUND): el explorador de `@nestjs/bullmq` necesita la cola
    // registrada en el módulo del worker. Cola PROPIA, no `email` (ruling C17).
    BullModule.registerQueue({ name: COLA_MIEMBROS }),
  ],
  controllers: [EventsController, MembersController, MyInvitationsController],
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
    UpdateEventUseCase,
    PublishEventUseCase,
    ListMembersUseCase,
    UpdateMemberUseCase,
    RevokeMemberUseCase,
    ListMyInvitationsUseCase,
    AcceptInvitationUseCase,
    DeclineInvitationUseCase,
    MemberInvitationProcessor,
  ],
  exports: [EventAccessService, EVENT_REPOSITORY, EventAccessGuard],
})
export class EventsModule {}
