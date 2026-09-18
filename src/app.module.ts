import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis'
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'
import { ThrottlerModule } from '@nestjs/throttler'

import { ConfigModule, ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { AuthModule } from '@/modules/auth/auth.module'
import { DatabaseModule } from '@/modules/database/database.module'
import { EventsModule } from '@/modules/events/events.module'
import { GuestsModule } from '@/modules/guests/guests.module'
import { MailModule } from '@/modules/mail/mail.module'
import { QueueModule } from '@/modules/queue/queue.module'
import { UsersModule } from '@/modules/users/users.module'
import { VendorsModule } from '@/modules/vendors/vendors.module'
import { LIMITADORES } from '@/shared/http/limitadores'
import { RequestIdMiddleware } from '@/shared/http/request-id.middleware'

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    MailModule,
    QueueModule,
    /**
     * Límite de ritmo con el contador en Redis, no en memoria: con varias
     * instancias, un límite por proceso multiplica el límite real por el
     * número de procesos.
     *
     * DESIGN-GAP: el brief declara un limitador `global` de 120/min, que sólo
     * actúa con un `ThrottlerGuard` GLOBAL (`APP_GUARD`). No se registra guard
     * global: el guard va por ruta (`@UseGuards(ThrottlerGuard)` en el RSVP
     * público y en `POST /auth/login`), y se declaran sólo los limitadores que
     * esas rutas usan. Motivos:
     *  1. `ThrottlerGuard` aplica TODOS los limitadores declarados a cada ruta
     *     que protege. Con un guard global, `rsvp` (5/min en el POST) y `login`
     *     caerían también sobre toda la API autenticada salvo que cada
     *     controlador se los saltara a mano — un olvido basta para limitar a 5
     *     peticiones una ruta que el frontend llama en bucle.
     *  2. El contador es por IP (`req.ip`), y sin `trust proxy` —que es de la
     *     Tarea 16, junto con helmet y CORS— detrás de un balanceador todos los
     *     usuarios comparten la IP del balanceador: 120/min "global" sería 120/min
     *     para TODA la aplicación. En las rutas públicas ese riesgo se asume
     *     (ver abajo); en la API autenticada, que ya exige sesión, no compensa.
     *  3. Los e2e de las rutas autenticadas no ganan un contador compartido
     *     entre tests que los vuelva dependientes del orden.
     * Hueco conocido para la Tarea 16: configurar `trust proxy`. Hasta entonces,
     * detrás de un proxy los límites del RSVP y del login cuentan por proxy, no
     * por cliente.
     */
    ThrottlerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        storage: new ThrottlerStorageRedisService(env.REDIS_URL),
        throttlers: LIMITADORES,
      }),
    }),
    UsersModule,
    AuthModule,
    EventsModule,
    VendorsModule,
    GuestsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*')
  }
}
