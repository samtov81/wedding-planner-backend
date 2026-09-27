import { Controller, Get, Query, UseGuards } from '@nestjs/common'

import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { decodeCursor } from '@/shared/domain'
import { LIMITADOR_VENDOR_CATALOG, LimiteDeRuta } from '@/shared/http/limitadores'
import { validarCon } from '@/shared/http/validar-con'

import { SearchVendorCatalogUseCase } from '../application/search-vendor-catalog.use-case'
import type { CategoriaVista } from '../domain/categoria'
import { vendorCatalogQuerySchema } from './vendor-catalog.dto'

interface PerfilRespuesta {
  id: string
  businessName: string
  category: CategoriaVista
  specialty: string | null
}

/** Cualquier usuario con sesión puede buscar proveedores para su evento. */
@UseGuards(JwtAuthGuard)
@Controller('vendors')
export class VendorCatalogController {
  constructor(private readonly buscar: SearchVendorCatalogUseCase) {}

  @LimiteDeRuta(LIMITADOR_VENDOR_CATALOG, { limit: 60, ttl: 60_000 })
  @Get()
  async buscarVendors(
    @Query() query: unknown,
  ): Promise<{ items: PerfilRespuesta[]; nextCursor: string | null }> {
    const datos = validarCon(vendorCatalogQuerySchema, query)
    const pagina = await this.buscar.ejecutar({
      q: datos.q,
      category: datos.category,
      // Un cursor ilegible es InvalidCursorError → 400 (filtro global).
      cursor: datos.cursor === undefined ? null : decodeCursor(datos.cursor),
      limit: datos.limit,
    })
    return {
      items: pagina.items.map(({ id, businessName, category, specialty }) => ({
        id,
        businessName,
        category,
        specialty,
      })),
      nextCursor: pagina.nextCursor,
    }
  }
}
