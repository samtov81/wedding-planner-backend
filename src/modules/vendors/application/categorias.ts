import { Inject, Injectable } from '@nestjs/common'

import { CategoriaDesconocidaError, type CategoriaDeProveedor } from '../domain/categoria'
import {
  VENDOR_CATEGORY_REPOSITORY,
  type VendorCategoryRepository,
} from './vendor-category.repository'

/**
 * Lista las categorías elegibles y convierte el `slug` que llega por la API
 * en la categoría completa. Lo usan la ficha de proveedor y los proveedores
 * de evento: un único sitio decide qué es una categoría válida.
 */
@Injectable()
export class CategoriasDeProveedor {
  constructor(
    @Inject(VENDOR_CATEGORY_REPOSITORY) private readonly categorias: VendorCategoryRepository,
  ) {}

  listar(): Promise<CategoriaDeProveedor[]> {
    return this.categorias.listarActivas()
  }

  async resolver(slug: string): Promise<CategoriaDeProveedor> {
    const categoria = await this.categorias.buscarActiva(slug)
    if (categoria === null) throw new CategoriaDesconocidaError()
    return categoria
  }
}
