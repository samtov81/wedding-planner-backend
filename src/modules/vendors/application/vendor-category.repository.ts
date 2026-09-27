import type { CategoriaDeProveedor } from '../domain/categoria'

export interface VendorCategoryRepository {
  /** Las que se pueden elegir, en el orden en que se muestran. */
  listarActivas(): Promise<CategoriaDeProveedor[]>
  /** `null` si no existe o está desactivada. */
  buscarActiva(slug: string): Promise<CategoriaDeProveedor | null>
}

export const VENDOR_CATEGORY_REPOSITORY = Symbol('VENDOR_CATEGORY_REPOSITORY')
