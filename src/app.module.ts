import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis'
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'

import { ConfigModule, ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { AuthModule } from '@/modules/auth/auth.module'
import { DatabaseModule } from '@/modules/database/database.module'
import { EventsModule } from '@/modules/events/events.module'
import { ExpensesModule } from '@/modules/expenses/expenses.module'
import { GuestsModule } from '@/modules/guests/guests.module'
import { HealthModule } from '@/modules/health/health.module'
import { MailModule } from '@/modules/mail/mail.module'
import { NotificationsModule } from '@/modules/notifications/notifications.module'
import { QueueModule } from '@/modules/queue/queue.module'
import { ScheduleModule } from '@/modules/schedule/schedule.module'
import { SeatingModule } from '@/modules/seating/seating.module'
import { UserProfileModule } from '@/modules/users/user-profile.module'
import { UsersModule } from '@/modules/users/users.module'
import { VendorsModule } from '@/modules/vendors/vendors.module'
import { crearLimitadores } from '@/shared/http/limitadores'
import { RequestIdMiddleware } from '@/shared/http/request-id.middleware'
import { RegistroModule } from '@/shared/logging/registro.module'

@Module({
  imports: [
    ConfigModule,
    RegistroModule,
    DatabaseModule,
    MailModule,
    QueueModule,
    /**
     * Límite de ritmo con el contador en Redis, no en memoria: con varias
     * instancias, un límite por proceso multiplica el límite real por el
     * número de procesos.
     *
     * `ThrottlerGuard` va como `APP_GUARD` (ruling C22): el limitador `global`
     * de 120/min por IP cubre TODA la API, y los limitadores con nombre (`rsvp`,
     * `login`) sólo las rutas que los piden con `@LimiteDeRuta`. El porqué y el
     * mecanismo (`skipIf`) están en `shared/http/limitadores.ts`.
     *
     * El contador es por `req.ip`: detrás de un balanceador, `TRUST_PROXY`
     * (Tarea 16, `configurarApp`) decide que salga del cliente y no del
     * balanceador. `/health` está exento (ver `HealthController`).
     */
    ThrottlerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        storage: new ThrottlerStorageRedisService(env.REDIS_URL),
        throttlers: crearLimitadores(120),
      }),
    }),
    UsersModule,
    UserProfileModule,
    AuthModule,
    EventsModule,
    VendorsModule,
    ScheduleModule,
    SeatingModule,
    ExpensesModule,
    GuestsModule,
    NotificationsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*')
  }
}
