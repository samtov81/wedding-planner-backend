import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { NotificationsModule } from '@/modules/notifications/notifications.module'
import { StorageModule } from '@/modules/storage/storage.module'
import { UsersModule } from '@/modules/users/users.module'

import { ADJUNTOS_DE_MENSAJES } from './application/adjuntos-de-mensajes.port'
import {
  BuscarAdjuntoVisible,
  DescargarAdjuntoUseCase,
  PrepararSubidaAdjuntoUseCase,
} from './application/adjuntos.use-cases'
import { COLA_MENSAJERIA } from './application/avisos-mensajeria'
import { CONVERSATION_REPOSITORY } from './application/conversation.repository'
import { GetContactStateUseCase } from './application/get-contact-state.use-case'
import { ListContactsUseCase } from './application/list-contacts.use-case'
import { ListConversationsUseCase } from './application/list-conversations.use-case'
import { ListMessagesUseCase } from './application/list-messages.use-case'
import { ListProfileConversationsUseCase } from './application/list-profile-conversations.use-case'
import { ListRoomReadersUseCase } from './application/list-room-readers.use-case'
import { ListRoomsUseCase } from './application/list-rooms.use-case'
import { MarkConversationUseCase } from './application/mark-conversation.use-case'
import { OpenConversationUseCase } from './application/open-conversation.use-case'
import { OpenRoomUseCase } from './application/open-room.use-case'
import { RequestContactUseCase } from './application/request-contact.use-case'
import { RespondContactUseCase } from './application/respond-contact.use-case'
import { SendMessageUseCase } from './application/send-message.use-case'
import { PrismaConversationRepository } from './infrastructure/prisma-conversation.repository'
import { ContactRequestsController } from './interfaces/contact-requests.controller'
import { ConversationsController } from './interfaces/conversations.controller'
import { MessagingProcessor } from './interfaces/messaging.processor'

/**
 * Mensajería: 1:1 y sala por evento (partes 1 y 2) y contacto desde la ficha de un
 * proveedor, conversaciones `PROFILE` sin evento (parte 3). `AuthModule` + `UsersModule` se
 * importan para que `JwtAuthGuard` resuelva con el mismo `TokenService` que el
 * resto del REST. `NotificationsModule` aporta `REALTIME_PORT` (el emisor de
 * Socket.IO sobre Redis) y `registerQueue` monta `MessagingProcessor` sobre la
 * cola propia `messaging`. No importa `EventsModule`: el acceso de mensajería lo decide
 * el propio repositorio (ver el docblock del controlador).
 *
 * Adjuntos (spec 2026-11-12): `StorageModule` aporta `SubidaDeAdjuntos` (subida
 * directa a R2 y URLs firmadas). Exporta UN puerto público,
 * `ADJUNTOS_DE_MENSAJES`, para que presupuesto convierta un adjunto en factura
 * con la misma regla de visibilidad que el listado, sin tocar el repositorio
 * de conversaciones. Se cablea con `useExisting` sobre `BuscarAdjuntoVisible`
 * (una sola instancia, la que también usa `DescargarAdjuntoUseCase`).
 * Alternativa descartada: exportar `CONVERSATION_REPOSITORY`, que obligaría a
 * cada consumidor a repetir la regla de visibilidad.
 */
@Module({
  imports: [
    AuthModule,
    UsersModule,
    NotificationsModule,
    StorageModule,
    BullModule.registerQueue({ name: COLA_MENSAJERIA }),
  ],
  controllers: [ConversationsController, ContactRequestsController],
  providers: [
    {
      provide: CONVERSATION_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaConversationRepository(prisma),
      inject: [PrismaService],
    },
    ListConversationsUseCase,
    ListContactsUseCase,
    OpenConversationUseCase,
    ListMessagesUseCase,
    SendMessageUseCase,
    MarkConversationUseCase,
    ListRoomsUseCase,
    OpenRoomUseCase,
    ListRoomReadersUseCase,
    RequestContactUseCase,
    RespondContactUseCase,
    GetContactStateUseCase,
    ListProfileConversationsUseCase,
    BuscarAdjuntoVisible,
    { provide: ADJUNTOS_DE_MENSAJES, useExisting: BuscarAdjuntoVisible },
    PrepararSubidaAdjuntoUseCase,
    DescargarAdjuntoUseCase,
    MessagingProcessor,
  ],
  exports: [ADJUNTOS_DE_MENSAJES],
})
export class MessagingModule {}
