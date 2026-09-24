import type { CursorPage, CursorValue } from '@/shared/domain'

export interface PerfilDeCatalogo {
  id: string
  businessName: string
  category: string
  specialty: string | null
  createdAt: Date
}

export interface BusquedaCatalogo {
  q: string | null
  category: string | null
  cursor: CursorValue | null
  limit: number
}

export interface VendorCatalogRepository {
  buscar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>>
}

export const VENDOR_CATALOG_REPOSITORY = Symbol('VENDOR_CATALOG_REPOSITORY')
