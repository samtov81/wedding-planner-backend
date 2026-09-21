import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import { MailModule } from '@/modules/mail/mail.module'
import { NotificationsModule } from '@/modules/notifications/notifications.module'
import { UsersModule } from '@/modules/users/users.module'

import { CreateGuestUseCase } from './application/create-guest.use-case'
import { DeleteGuestUseCase } from './application/delete-guest.use-case'
import { GetGuestUseCase } from './application/get-guest.use-case'
import { GetRsvpUseCase } from './application/get-rsvp.use-case'
import { GUEST_REPOSITORY } from './application/guest.repository'
import { GuestSummaryUseCase } from './application/guest-summary.use-case'
import { HandleDeliveryEventUseCase } from './application/handle-delivery-event.use-case'
import { INVITATION_REPOSITORY } from './application/invitation.repository'
import { ListGuestsUseCase } from './application/list-guests.use-case'
import { COLA_INVITACIONES, SendInvitationsUseCase } from './application/send-invitations.use-case'
import { SendSingleInvitationUseCase } from './application/send-single-invitation.use-case'
import { SubmitRsvpUseCase } from './application/submit-rsvp.use-case'
import { UpdateGuestUseCase } from './application/update-guest.use-case'
import { WEBHOOK_SIGNATURE_VERIFIER } from './application/webhook-signature.verifier'
import { PrismaGuestRepository } from './infrastructure/prisma-guest.repository'
import { PrismaInvitationRepository } from './infrastructure/prisma-invitation.repository'
import { SvixSignatureVerifier } from './infrastructure/svix-signature.verifier'
import { GuestsController } from './interfaces/guests.controller'
import { InvitationProcessor } from './interfaces/invitation.processor'
import { ResendWebhookController } from './interfaces/resend-webhook.controller'
import { RsvpController } from './interfaces/rsvp.controller'

/**
 * `EventsModule` se IMPORTA para consumir `EventAccessGuard` tal cual: es el
 * punto ÚNICO de autorización sobre eventos y reconstruirlo aquí sería una
 * copia que puede divergir. `AuthModule` + `UsersModule` por el mismo motivo
 * que en `VendorsModule`: `JwtAuthGuard` inyecta `USER_REPOSITORY`.
 *
 * `GUEST_REPOSITORY` se EXPORTA: el envío masivo de invitaciones (Tarea 12)
 * consume `listarTodos` a través del puerto, sin tocar este `infrastructure/`.
 * `INVITATION_REPOSITORY` se exporta por el mismo motivo, para el webhook del
 * proveedor (Tarea 13) y el RSVP público (Tarea 14).
 *
 * `NotificationsModule` aporta los puertos que el RSVP público usa para avisar
 * a la pareja; `UNIDAD_DE_TRABAJO` llega del `DatabaseModule` global.
 */
@Module({
  imports: [
    AuthModule,
    UsersModule,
    EventsModule,
    MailModule,
    NotificationsModule,
    // El worker de `@Processor` lo monta el explorador de `@nestjs/bullmq`, y
    // para eso la cola tiene que estar registrada en este módulo: sin este
    // `registerQueue`, `InvitationProcessor` no arranca (NO_QUEUE_FOUND).
    // Su cola PROPIA, no `email` (ruling C17; ver `COLA_INVITACIONES`).
    BullModule.registerQueue({ name: COLA_INVITACIONES }),
  ],
  // `ResendWebhookController` y `RsvpController` NO llevan guards de usuario:
  // la autenticación del primero es la firma Svix, la del segundo el token de
  // la URL (ver el docblock de cada controlador).
  controllers: [GuestsController, ResendWebhookController, RsvpController],
  providers: [
    {
      provide: GUEST_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaGuestRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: INVITATION_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaInvitationRepository(prisma),
      inject: [PrismaService],
    },
    ListGuestsUseCase,
    GetGuestUseCase,
    GuestSummaryUseCase,
    CreateGuestUseCase,
    UpdateGuestUseCase,
    DeleteGuestUseCase,
    SendInvitationsUseCase,
    SendSingleInvitationUseCase,
    InvitationProcessor,
    HandleDeliveryEventUseCase,
    GetRsvpUseCase,
    SubmitRsvpUseCase,
    { provide: WEBHOOK_SIGNATURE_VERIFIER, useClass: SvixSignatureVerifier },
  ],
  exports: [GUEST_REPOSITORY, INVITATION_REPOSITORY],
})
export class GuestsModule {}
