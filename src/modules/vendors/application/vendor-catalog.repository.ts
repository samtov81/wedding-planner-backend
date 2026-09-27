import type { CursorPage, CursorValue } from '@/shared/domain'

import type { CategoriaVista } from '../domain/categoria'

export interface PerfilDeCatalogo {
  id: string
  businessName: string
  category: CategoriaVista
  specialty: string | null
  createdAt: Date
}

export interface BusquedaCatalogo {
  q: string | null
  /** `slug` de la categoría. */
  category: string | null
  cursor: CursorValue | null
  limit: number
}

export interface VendorCatalogRepository {
  buscar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>>
}

export const VENDOR_CATALOG_REPOSITORY = Symbol('VENDOR_CATALOG_REPOSITORY')
