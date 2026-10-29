import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { UsersModule } from '@/modules/users/users.module'

import { CONVERSATION_REPOSITORY } from './application/conversation.repository'
import { ListContactsUseCase } from './application/list-contacts.use-case'
import { ListConversationsUseCase } from './application/list-conversations.use-case'
import { ListMessagesUseCase } from './application/list-messages.use-case'
import { MarkConversationUseCase } from './application/mark-conversation.use-case'
import { OpenConversationUseCase } from './application/open-conversation.use-case'
import { SendMessageUseCase } from './application/send-message.use-case'
import { PrismaConversationRepository } from './infrastructure/prisma-conversation.repository'
import { ConversationsController } from './interfaces/conversations.controller'

/**
 * Mensajería 1:1 por evento (parte 1: REST). `AuthModule` + `UsersModule` se
 * importan para que `JwtAuthGuard` resuelva con el mismo `TokenService` que el
 * resto del REST. No importa `EventsModule`: el acceso de mensajería lo decide
 * el propio repositorio (ver el docblock del controlador).
 */
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [ConversationsController],
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
  ],
})
export class MessagingModule {}
