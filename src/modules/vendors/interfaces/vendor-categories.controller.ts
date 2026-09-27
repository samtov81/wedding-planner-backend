import { Controller, Get, UseGuards } from '@nestjs/common'

import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'

import { CategoriasDeProveedor } from '../application/categorias'
import { aCategoriaVista, type CategoriaVista } from '../domain/categoria'

/**
 * Opciones del select de categoría (ficha de proveedor, filtro del catálogo,
 * proveedores del evento). Sólo las activas, en su orden.
 */
@UseGuards(JwtAuthGuard)
@Controller('vendor-categories')
export class VendorCategoriesController {
  constructor(private readonly categorias: CategoriasDeProveedor) {}

  @Get()
  async listar(): Promise<{ items: CategoriaVista[] }> {
    return { items: (await this.categorias.listar()).map(aCategoriaVista) }
  }
}
