import { Module } from '@nestjs/common'

import { NOTIFICATION_PORT } from './application/notification.port'
import { REALTIME_PORT } from './application/realtime.port'
import { NotificationPortEnMemoria } from './infrastructure/notification.port.fake'
import { RealtimePortEnMemoria } from './infrastructure/realtime.port.fake'

/**
 * Dueño de los puertos de notificación y tiempo real. La Tarea 14 los DEFINE
 * (el RSVP público es el primero que los necesita) y la Tarea 15 aporta los
 * adaptadores reales — Prisma para `Notification` y Socket.IO sobre Redis.
 *
 * DESIGN-GAP (temporal, hasta la Tarea 15): se cablean los DOBLES en memoria,
 * como pide el brief ("hasta entonces se usan los dobles"). Consecuencias
 * conocidas y aceptadas porque nada se despliega antes de la Tarea 16 (el
 * build ni siquiera arranca hasta entonces, ruling C20):
 *  - `NotificationPortEnMemoria` no tiene miembros registrados, así que no crea
 *    ninguna notificación;
 *  - `RealtimePortEnMemoria` guarda cada emisión en un array que sólo crece.
 * La Tarea 15 sustituye estos dos `useFactory` y nada más: los casos de uso ya
 * dependen sólo de los puertos.
 *
 * Vive en su propio módulo, y no dentro de `GuestsModule`, porque la regla
 * `modulos-no-se-tocan-las-tripas` impide que `guests` importe la
 * `infrastructure/` de `notifications`.
 */
@Module({
  providers: [
    { provide: NOTIFICATION_PORT, useFactory: () => new NotificationPortEnMemoria() },
    { provide: REALTIME_PORT, useFactory: () => new RealtimePortEnMemoria() },
  ],
  exports: [NOTIFICATION_PORT, REALTIME_PORT],
})
export class NotificationsModule {}
