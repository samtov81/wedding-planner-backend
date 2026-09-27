import type { VendorCategoryRepository } from '../application/vendor-category.repository'
import type { CategoriaDeProveedor } from '../domain/categoria'

/**
 * Las mismas categorías que siembra la migración
 * `20260929120000_vendor_categories`, en el mismo orden. La paridad con
 * Postgres (`vendor-category.repository.paridad.test.ts`) comprueba que no se
 * desincronicen. Los `id` son fijos para que los tests puedan referirlos.
 */
export const CATEGORIAS_SEMBRADAS: readonly CategoriaDeProveedor[] = [
  { id: '00000000-0000-4000-8000-000000000001', slug: 'venue', name: 'Venue' },
  { id: '00000000-0000-4000-8000-000000000002', slug: 'catering', name: 'Catering' },
  { id: '00000000-0000-4000-8000-000000000003', slug: 'photography', name: 'Photography' },
  { id: '00000000-0000-4000-8000-000000000004', slug: 'decor-floral', name: 'Decor & Floral' },
  {
    id: '00000000-0000-4000-8000-000000000005',
    slug: 'music-entertainment',
    name: 'Music & Entertainment',
  },
  { id: '00000000-0000-4000-8000-000000000006', slug: 'attire-beauty', name: 'Attire & Beauty' },
  { id: '00000000-0000-4000-8000-000000000007', slug: 'stationery', name: 'Stationery' },
  { id: '00000000-0000-4000-8000-000000000008', slug: 'media', name: 'Media' },
]

/** Para tests: la categoría sembrada con ese slug. */
export function categoriaSembrada(slug: string): CategoriaDeProveedor {
  const categoria = CATEGORIAS_SEMBRADAS.find((c) => c.slug === slug)
  if (categoria === undefined) throw new Error(`No hay categoría sembrada "${slug}"`)
  return { ...categoria }
}

export class VendorCategoryRepositoryEnMemoria implements VendorCategoryRepository {
  private readonly inactivas = new Set<string>()

  /** Para tests: una categoría desactivada. */
  desactivar(slug: string): void {
    this.inactivas.add(slug)
  }

  listarActivas(): Promise<CategoriaDeProveedor[]> {
    return Promise.resolve(
      CATEGORIAS_SEMBRADAS.filter((c) => !this.inactivas.has(c.slug)).map((c) => ({ ...c })),
    )
  }

  buscarActiva(slug: string): Promise<CategoriaDeProveedor | null> {
    if (this.inactivas.has(slug)) return Promise.resolve(null)
    const categoria = CATEGORIAS_SEMBRADAS.find((c) => c.slug === slug)
    return Promise.resolve(categoria === undefined ? null : { ...categoria })
  }
}
