import { encodeCursor, type CursorPage } from '@/shared/domain'

import type {
  BusquedaCatalogo,
  PerfilDeCatalogo,
  VendorCatalogRepository,
} from '../application/vendor-catalog.repository'
import { precioDesde } from '../domain/vendor-profile'

export interface FotoEnMemoria {
  id: string
  storageKey: string
  position: number
}

/**
 * Lo que el doble guarda: los datos de partida (precios y fotos con su
 * `position`), no los derivados. Así la paridad prueba que Prisma y el doble
 * DERIVAN igual `priceFrom` e `imageKey`, en vez de comparar un valor que el
 * test escribió a mano en ambos lados.
 */
export interface PerfilEnMemoria extends Omit<PerfilDeCatalogo, 'priceFrom' | 'imageKey'> {
  status: 'DRAFT' | 'PUBLISHED' | 'SUSPENDED'
  /** Precio de cada paquete, normalizado ("4500.00"). */
  precios: string[]
  fotos: FotoEnMemoria[]
}

/** La primera foto por `position` y, a igual `position`, por `id` (como Prisma). */
function primeraFoto(fotos: readonly FotoEnMemoria[]): FotoEnMemoria | undefined {
  return [...fotos].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))[0]
}

function aPerfil({ status: _s, precios, fotos, ...perfil }: PerfilEnMemoria): PerfilDeCatalogo {
  return {
    ...perfil,
    priceFrom: precioDesde(precios.map((price) => ({ price }))),
    imageKey: primeraFoto(fotos)?.storageKey ?? null,
  }
}

export class VendorCatalogRepositoryEnMemoria implements VendorCatalogRepository {
  readonly perfiles: PerfilEnMemoria[] = []

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

    const items = candidatos.slice(0, busqueda.limit).map(aPerfil)
    const ultimo = items.at(-1)
    const nextCursor =
      candidatos.length > busqueda.limit && ultimo !== undefined
        ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id })
        : null
    return Promise.resolve({ items, nextCursor })
  }
}
