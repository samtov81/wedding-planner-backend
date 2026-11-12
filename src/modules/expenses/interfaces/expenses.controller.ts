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
import type { SubidaPreparada } from '@/modules/storage/application/subida-directa'
import { decodeCursor, UnauthorizedError } from '@/shared/domain'
import { idDeRuta } from '@/shared/http/id-de-ruta'
import { validarCon } from '@/shared/http/validar-con'

import {
  ArchivoDeGastoUseCase,
  PrepararSubidaFacturaUseCase,
} from '../application/archivos-de-factura.use-cases'
import { BudgetSummaryUseCase } from '../application/budget-summary.use-case'
import { CreateExpenseUseCase } from '../application/create-expense.use-case'
import { DeleteExpenseUseCase } from '../application/delete-expense.use-case'
import { ListExpensesUseCase } from '../application/list-expenses.use-case'
import { UpdateExpenseUseCase } from '../application/update-expense.use-case'
import type { ResumenPresupuesto } from '../domain/expense'
import { GastoNoEncontradoError } from '../domain/expense-errors'
import {
  createExpenseSchema,
  listExpensesQuerySchema,
  updateExpenseSchema,
  uploadUrlSchema,
} from './expenses.dto'
import { aGastoJson, type GastoJson } from './expenses.json'

/**
 * El presupuesto es privado del creador (`accesoAlPresupuesto`): leer exige
 * `BUDGET_VIEW` y escribir `BUDGET_EDIT`; quien está en el evento sin ese
 * permiso recibe 403.
 */
@UseGuards(JwtAuthGuard, EventAccessGuard)
@Controller('events/:eventId')
export class ExpensesController {
  constructor(
    private readonly listar: ListExpensesUseCase,
    private readonly crear: CreateExpenseUseCase,
    private readonly actualizar: UpdateExpenseUseCase,
    private readonly eliminar: DeleteExpenseUseCase,
    private readonly resumen: BudgetSummaryUseCase,
    private readonly prepararSubida: PrepararSubidaFacturaUseCase,
    private readonly archivoDeGasto: ArchivoDeGastoUseCase,
  ) {}

  @RequireEventAccess('BUDGET_VIEW')
  @Get('expenses')
  async listarGastos(
    @Param('eventId') eventId: string,
    @Query() query: unknown,
  ): Promise<{ items: GastoJson[]; nextCursor: string | null }> {
    const q = validarCon(listExpensesQuerySchema, query)
    const pagina = await this.listar.ejecutar(
      eventId,
      {
        status: q.status ?? null,
        origin: q.origin ?? null,
        eventVendorId: q.eventVendorId ?? null,
        q: q.q ?? null,
      },
      q.cursor === undefined ? null : decodeCursor(q.cursor),
      q.limit,
    )
    return { items: pagina.items.map(aGastoJson), nextCursor: pagina.nextCursor }
  }

  @RequireEventAccess('BUDGET_EDIT')
  @Post('expenses')
  async crearGasto(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<GastoJson> {
    const yo = exigirUsuario(usuario)
    const d = validarCon(createExpenseSchema, body)
    return aGastoJson(
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
          invoiceNumber: d.invoiceNumber ?? null,
          subtotal: d.subtotal ?? null,
          invoiceFile: d.invoiceFile ?? null,
        },
        yo.id,
      ),
    )
  }

  /** Antes que `expenses/:expenseId/...`: la ruta literal no debe leerse como un id. */
  @RequireEventAccess('BUDGET_EDIT')
  @Post('expenses/invoice-upload-url')
  @HttpCode(201)
  async urlDeSubida(
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<SubidaPreparada> {
    const { contentType, bytes } = validarCon(uploadUrlSchema, body)
    return await this.prepararSubida.ejecutar(eventId, contentType, bytes)
  }

  @RequireEventAccess('BUDGET_VIEW')
  @Get('expenses/:expenseId/invoice-file')
  async archivoDeFactura(
    @Param('eventId') eventId: string,
    @Param('expenseId') expenseId: string,
  ): Promise<{ url: string }> {
    return await this.archivoDeGasto.ejecutar(
      eventId,
      idDeRuta(expenseId, () => new GastoNoEncontradoError()),
    )
  }

  @RequireEventAccess('BUDGET_EDIT')
  @Patch('expenses/:expenseId')
  async editarGasto(
    @Param('eventId') eventId: string,
    @Param('expenseId') expenseId: string,
    @Body() body: unknown,
  ): Promise<GastoJson> {
    const id = idDeRuta(expenseId, () => new GastoNoEncontradoError())
    return aGastoJson(
      await this.actualizar.ejecutar(eventId, id, validarCon(updateExpenseSchema, body)),
    )
  }

  @RequireEventAccess('BUDGET_EDIT')
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

  @RequireEventAccess('BUDGET_VIEW')
  @Get('budget-summary')
  async verResumen(
    @Param('eventId') eventId: string,
  ): Promise<Omit<ResumenPresupuesto, 'upcoming'> & { upcoming: GastoJson[] }> {
    const r = await this.resumen.ejecutar(eventId)
    return { ...r, upcoming: r.upcoming.map(aGastoJson) }
  }
}

function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}
