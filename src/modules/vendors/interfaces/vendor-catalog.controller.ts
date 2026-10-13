import { Controller, Get, Query, UseGuards } from '@nestjs/common'

import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { decodeCursor } from '@/shared/domain'
import { LIMITADOR_VENDOR_CATALOG, LimiteDeRuta } from '@/shared/http/limitadores'
import { validarCon } from '@/shared/http/validar-con'

import {
  type CatalogoVista,
  SearchVendorCatalogUseCase,
} from '../application/search-vendor-catalog.use-case'
import { vendorCatalogQuerySchema } from './vendor-catalog.dto'

/** Cualquier usuario con sesión puede buscar proveedores para su evento. */
@UseGuards(JwtAuthGuard)
@Controller('vendors')
export class VendorCatalogController {
  constructor(private readonly buscar: SearchVendorCatalogUseCase) {}

  @LimiteDeRuta(LIMITADOR_VENDOR_CATALOG, { limit: 60, ttl: 60_000 })
  @Get()
  async buscarVendors(
    @Query() query: unknown,
  ): Promise<{ items: CatalogoVista[]; nextCursor: string | null }> {
    const datos = validarCon(vendorCatalogQuerySchema, query)
    const pagina = await this.buscar.ejecutar({
      q: datos.q,
      category: datos.category,
      // Un cursor ilegible es InvalidCursorError → 400 (filtro global).
      cursor: datos.cursor === undefined ? null : decodeCursor(datos.cursor),
      limit: datos.limit,
    })
    return {
      // Lista blanca explícita: si la vista gana un campo, salir por la API
      // es una decisión que se toma aquí, no un efecto de propagar el objeto.
      items: pagina.items.map(
        ({ id, businessName, category, specialty, currency, priceFrom, imageUrl }) => ({
          id,
          businessName,
          category,
          specialty,
          currency,
          priceFrom,
          imageUrl,
        }),
      ),
      nextCursor: pagina.nextCursor,
    }
  }
}
