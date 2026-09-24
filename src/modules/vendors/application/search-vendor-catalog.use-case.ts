import { Inject, Injectable } from '@nestjs/common'

import type { CursorPage } from '@/shared/domain'

import {
  type BusquedaCatalogo,
  type PerfilDeCatalogo,
  VENDOR_CATALOG_REPOSITORY,
  type VendorCatalogRepository,
} from './vendor-catalog.repository'

@Injectable()
export class SearchVendorCatalogUseCase {
  constructor(
    @Inject(VENDOR_CATALOG_REPOSITORY) private readonly catalogo: VendorCatalogRepository,
  ) {}

  /** Solo búsqueda: el marketplace completo (fichas, reseñas) queda fuera de alcance. */
  async ejecutar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>> {
    return await this.catalogo.buscar(busqueda)
  }
}
