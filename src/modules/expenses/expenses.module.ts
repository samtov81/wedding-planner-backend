import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import { MessagingModule } from '@/modules/messaging/messaging.module'
import { NotificationsModule } from '@/modules/notifications/notifications.module'
import { StorageModule } from '@/modules/storage/storage.module'
import { UsersModule } from '@/modules/users/users.module'

import {
  ArchivoDeGastoUseCase,
  FacturaDesdeMensajeUseCase,
  PrepararSubidaFacturaUseCase,
} from './application/archivos-de-factura.use-cases'
import { COLA_GASTOS } from './application/avisos-gastos'
import { BudgetSummaryUseCase } from './application/budget-summary.use-case'
import { CreateExpenseUseCase } from './application/create-expense.use-case'
import { DeleteExpenseUseCase } from './application/delete-expense.use-case'
import { EXPENSE_REPOSITORY } from './application/expense.repository'
import { ListExpensesUseCase } from './application/list-expenses.use-case'
import { PagosRecibidosUseCase } from './application/pagos-recibidos.use-cases'
import { UpdateExpenseUseCase } from './application/update-expense.use-case'
import { PrismaExpenseRepository } from './infrastructure/prisma-expense.repository'
import { ExpensesController } from './interfaces/expenses.controller'
import { GastosProcessor } from './interfaces/expenses.processor'
import { VendorPaymentsController } from './interfaces/vendor-payments.controller'

/**
 * `EventsModule` se importa por el mismo motivo que en `VendorsModule` y
 * `ScheduleModule`: `EventAccessGuard`/`RequireEventAccess` son el único
 * punto de autorización sobre eventos, y `EVENT_REPOSITORY` (que también
 * exporta) lo usa `BudgetSummaryUseCase` para leer moneda y presupuesto
 * total. `UsersModule` porque `JwtAuthGuard` necesita `USER_REPOSITORY`.
 *
 * Facturas y avisos (spec 2026-11-11 §7 y §9):
 *  - `NotificationsModule`: `NOTIFICATION_PORT` (campana `expense.paid` dentro
 *    de la transacción) y, para el worker, `REALTIME_PORT`.
 *  - `StorageModule`: `SubidaDeFacturas` (subida directa a R2 y URLs firmadas).
 *  - `MessagingModule`: `ADJUNTOS_DE_MENSAJES`, el puerto público con el que
 *    `FacturaDesdeMensajeUseCase` lee el adjunto de un mensaje (spec 2026-11-12).
 *    Sólo importa el puerto: `MessagingModule` no importa este módulo.
 *  - `registerQueue('expenses')`: el explorador de `@nestjs/bullmq` necesita la
 *    cola registrada en el módulo para montar el worker sobre ella.
 *
 * `UNIDAD_DE_TRABAJO` y `QUEUE_PORT` llegan de `DatabaseModule` y `QueueModule`,
 * que son globales.
 */
@Module({
  imports: [
    AuthModule,
    UsersModule,
    EventsModule,
    NotificationsModule,
    StorageModule,
    MessagingModule,
    BullModule.registerQueue({ name: COLA_GASTOS }),
  ],
  controllers: [ExpensesController, VendorPaymentsController],
  providers: [
    {
      provide: EXPENSE_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaExpenseRepository(prisma),
      inject: [PrismaService],
    },
    ListExpensesUseCase,
    CreateExpenseUseCase,
    UpdateExpenseUseCase,
    DeleteExpenseUseCase,
    BudgetSummaryUseCase,
    PrepararSubidaFacturaUseCase,
    ArchivoDeGastoUseCase,
    FacturaDesdeMensajeUseCase,
    PagosRecibidosUseCase,
    GastosProcessor,
  ],
})
export class ExpensesModule {}
