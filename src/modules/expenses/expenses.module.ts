import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import { UsersModule } from '@/modules/users/users.module'

import { BudgetSummaryUseCase } from './application/budget-summary.use-case'
import { CreateExpenseUseCase } from './application/create-expense.use-case'
import { DeleteExpenseUseCase } from './application/delete-expense.use-case'
import { EXPENSE_REPOSITORY } from './application/expense.repository'
import { ListExpensesUseCase } from './application/list-expenses.use-case'
import { UpdateExpenseUseCase } from './application/update-expense.use-case'
import { PrismaExpenseRepository } from './infrastructure/prisma-expense.repository'
import { ExpensesController } from './interfaces/expenses.controller'

/**
 * `EventsModule` se importa por el mismo motivo que en `VendorsModule` y
 * `ScheduleModule`: `EventAccessGuard`/`RequireEventAccess` son el único
 * punto de autorización sobre eventos, y `EVENT_REPOSITORY` (que también
 * exporta) lo usa `BudgetSummaryUseCase` para leer moneda y presupuesto
 * total. `UsersModule` porque `JwtAuthGuard` necesita `USER_REPOSITORY`.
 */
@Module({
  imports: [AuthModule, UsersModule, EventsModule],
  controllers: [ExpensesController],
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
  ],
})
export class ExpensesModule {}
