import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'

import { ConfigModule } from '@/config/config.module'
import { DatabaseModule } from '@/modules/database/database.module'
import { MailModule } from '@/modules/mail/mail.module'
import { RequestIdMiddleware } from '@/shared/http/request-id.middleware'

@Module({
  imports: [ConfigModule, DatabaseModule, MailModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*')
  }
}
