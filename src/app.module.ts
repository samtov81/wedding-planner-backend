import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'

import { ConfigModule } from '@/config/config.module'
import { DatabaseModule } from '@/modules/database/database.module'
import { MailModule } from '@/modules/mail/mail.module'
import { QueueModule } from '@/modules/queue/queue.module'
import { UsersModule } from '@/modules/users/users.module'
import { RequestIdMiddleware } from '@/shared/http/request-id.middleware'

@Module({
  imports: [ConfigModule, DatabaseModule, MailModule, QueueModule, UsersModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*')
  }
}
