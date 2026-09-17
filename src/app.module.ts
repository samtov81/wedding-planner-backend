import { Module } from '@nestjs/common'

import { ConfigModule } from '@/config/config.module'
import { DatabaseModule } from '@/modules/database/database.module'

@Module({
  imports: [ConfigModule, DatabaseModule],
})
export class AppModule {}
