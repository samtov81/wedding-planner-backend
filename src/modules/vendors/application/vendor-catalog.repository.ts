import type { CursorPage, CursorValue } from '@/shared/domain'

import type { CategoriaVista } from '../domain/categoria'

/**
 * Un ítem del catálogo tal como lo guarda la base. `imageKey` es la key de
 * almacenamiento de la primera foto del portfolio, NUNCA una URL: firmarla es
 * decisión del caso de uso, porque la URL caduca y el repositorio no sabe
 * cuándo se va a pintar. `currency` y `priceFrom` siguen las mismas reglas
 * que `similar` en la ficha pública (`aSimilar`, `ficha-vista.ts`).
 */
export interface PerfilDeCatalogo {
  id: string
  businessName: string
  category: CategoriaVista
  specialty: string | null
  /** Moneda de la ficha (ISO 4217). */
  currency: string
  /** El paquete más barato (`precioDesde`); `null` sin paquetes. */
  priceFrom: string | null
  /** Primera foto por `position` (empate: `id`), como la ficha; `null` sin fotos. */
  imageKey: string | null
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
