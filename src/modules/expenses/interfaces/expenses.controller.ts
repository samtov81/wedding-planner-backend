import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { EventAccessGuard } from '@/modules/events/interfaces/event-access.guard'
import { RequireEventAccess } from '@/modules/events/interfaces/require-event-access.decorator'
import { decodeCursor, UnauthorizedError } from '@/shared/domain'
import { idDeRuta } from '@/shared/http/id-de-ruta'
import { validarCon } from '@/shared/http/validar-con'

import { BudgetSummaryUseCase } from '../application/budget-summary.use-case'
import { CreateExpenseUseCase } from '../application/create-expense.use-case'
import { DeleteExpenseUseCase } from '../application/delete-expense.use-case'
import { ListExpensesUseCase } from '../application/list-expenses.use-case'
import { UpdateExpenseUseCase } from '../application/update-expense.use-case'
import type { Expense, ResumenPresupuesto } from '../domain/expense'
import { GastoNoEncontradoError } from '../domain/expense-errors'
import { createExpenseSchema, listExpensesQuerySchema, updateExpenseSchema } from './expenses.dto'

interface GastoRespuesta {
  id: string
  origin:
    | { kind: 'vendor'; eventVendorId: string; vendorName: string }
    | { kind: 'external'; payeeName: string }
  concept: string
  category: string
  amount: string
  status: 'PENDING' | 'PAID'
  dueDate: string | null
  paidAt: string | null
  notes: string | null
  createdAt: string
}

@UseGuards(JwtAuthGuard, EventAccessGuard)
@Controller('events/:eventId')
export class ExpensesController {
  constructor(
    private readonly listar: ListExpensesUseCase,
    private readonly crear: CreateExpenseUseCase,
    private readonly actualizar: UpdateExpenseUseCase,
    private readonly eliminar: DeleteExpenseUseCase,
    private readonly resumen: BudgetSummaryUseCase,
  ) {}

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get('expenses')
  async listarGastos(
    @Param('eventId') eventId: string,
    @Query() query: unknown,
  ): Promise<{ items: GastoRespuesta[]; nextCursor: string | null }> {
    const q = validarCon(listExpensesQuerySchema, query)
    const pagina = await this.listar.ejecutar(
      eventId,
      {
        status: q.status ?? null,
        origin: q.origin ?? null,
        eventVendorId: q.eventVendorId ?? null,
      },
      q.cursor === undefined ? null : decodeCursor(q.cursor),
      q.limit,
    )
    return { items: pagina.items.map(aRespuesta), nextCursor: pagina.nextCursor }
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post('expenses')
  async crearGasto(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<GastoRespuesta> {
    const yo = exigirUsuario(usuario)
    const d = validarCon(createExpenseSchema, body)
    return aRespuesta(
      await this.crear.ejecutar(
        eventId,
        {
          origen: d.origen,
          concept: d.concept,
          category: d.category,
          amount: d.amount,
          dueDate: d.dueDate ?? null,
          notes: d.notes ?? null,
          status: d.status,
        },
        yo.id,
      ),
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Patch('expenses/:expenseId')
  async editarGasto(
    @Param('eventId') eventId: string,
    @Param('expenseId') expenseId: string,
    @Body() body: unknown,
  ): Promise<GastoRespuesta> {
    const id = idDeRuta(expenseId, () => new GastoNoEncontradoError())
    return aRespuesta(
      await this.actualizar.ejecutar(eventId, id, validarCon(updateExpenseSchema, body)),
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Delete('expenses/:expenseId')
  @HttpCode(204)
  async borrarGasto(
    @Param('eventId') eventId: string,
    @Param('expenseId') expenseId: string,
  ): Promise<void> {
    await this.eliminar.ejecutar(
      eventId,
      idDeRuta(expenseId, () => new GastoNoEncontradoError()),
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get('budget-summary')
  async verResumen(@Param('eventId') eventId: string): Promise<ResumenPresupuesto> {
    return await this.resumen.ejecutar(eventId)
  }
}

function aRespuesta(g: Expense): GastoRespuesta {
  return {
    id: g.id,
    origin: g.origen,
    concept: g.concept,
    category: g.category,
    amount: g.amount,
    status: g.status,
    dueDate: g.dueDate?.toISOString().slice(0, 10) ?? null,
    paidAt: g.paidAt?.toISOString() ?? null,
    notes: g.notes,
    createdAt: g.createdAt.toISOString(),
  }
}

function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}
