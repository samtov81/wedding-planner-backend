import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { UnauthorizedError } from '@/shared/domain'
import { idDeRuta } from '@/shared/http/id-de-ruta'
import { validarCon } from '@/shared/http/validar-con'

import { PagosRecibidosUseCase } from '../application/pagos-recibidos.use-cases'
import { PagoRecibidoNoEncontradoError } from '../domain/expense-errors'
import { vendorPaymentsQuerySchema } from './expenses.dto'
import { aPagosDeEventoJson, type PagosDeEventoJson } from './expenses.json'

/**
 * Lo que cobra el proveedor, de todos sus eventos (spec 2026-11-11 §8). Va en
 * `/me` y sin `EventAccessGuard`: un proveedor no es miembro del evento, y la
 * regla de qué pagos ve vive en el puerto del repositorio.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/vendor-payments')
export class VendorPaymentsController {
  constructor(private readonly pagos: PagosRecibidosUseCase) {}

  @Get()
  async listar(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Query() query: unknown,
  ): Promise<{ events: PagosDeEventoJson[] }> {
    const yo = exigirUsuario(usuario)
    const q = validarCon(vendorPaymentsQuerySchema, query)
    const eventos = await this.pagos.listar(yo.id, q.eventId ?? null)
    return { events: eventos.map(aPagosDeEventoJson) }
  }

  @Get(':expenseId/invoice-file')
  async archivo(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('expenseId') expenseId: string,
  ): Promise<{ url: string }> {
    const yo = exigirUsuario(usuario)
    return await this.pagos.archivo(
      yo.id,
      idDeRuta(expenseId, () => new PagoRecibidoNoEncontradoError()),
    )
  }
}

function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}
