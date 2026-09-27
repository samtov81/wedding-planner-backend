import { encodeCursor, type CursorPage } from '@/shared/domain'

import type {
  BusquedaCatalogo,
  PerfilDeCatalogo,
  VendorCatalogRepository,
} from '../application/vendor-catalog.repository'

export class VendorCatalogRepositoryEnMemoria implements VendorCatalogRepository {
  readonly perfiles: Array<PerfilDeCatalogo & { status: 'DRAFT' | 'PUBLISHED' | 'SUSPENDED' }> = []

  buscar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>> {
    const q = busqueda.q?.toLowerCase() ?? null
    const categoria = busqueda.category
    const { cursor } = busqueda
    const candidatos = this.perfiles
      .filter((p) => p.status === 'PUBLISHED')
      .filter((p) => categoria === null || p.category.slug === categoria)
      .filter(
        (p) =>
          q === null ||
          p.businessName.toLowerCase().includes(q) ||
          (p.specialty?.toLowerCase().includes(q) ?? false),
      )
      .filter(
        (p) =>
          cursor === null ||
          p.createdAt.getTime() > cursor.createdAt.getTime() ||
          (p.createdAt.getTime() === cursor.createdAt.getTime() && p.id > cursor.id),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))

    const items = candidatos.slice(0, busqueda.limit).map(({ status: _s, ...perfil }) => perfil)
    const ultimo = items.at(-1)
    const nextCursor =
      candidatos.length > busqueda.limit && ultimo !== undefined
        ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id })
        : null
    return Promise.resolve({ items, nextCursor })
  }
}
