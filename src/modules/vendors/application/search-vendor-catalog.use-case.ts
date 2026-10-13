import { Inject, Injectable } from '@nestjs/common'

import { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'
import type { CursorPage } from '@/shared/domain'

import type { CategoriaVista } from '../domain/categoria'
import {
  type BusquedaCatalogo,
  type PerfilDeCatalogo,
  VENDOR_CATALOG_REPOSITORY,
  type VendorCatalogRepository,
} from './vendor-catalog.repository'

/**
 * Un ítem del catálogo tal como se pinta en la tarjeta del marketplace.
 *
 * Hoy tiene la misma forma que `SimilarVista` (`ficha-vista.ts`) y se calcula
 * con las mismas reglas, pero es un tipo propio a propósito: un alias ataría
 * el catálogo a lo que la ficha decida añadir a sus "similares" (y al revés).
 * Sin `imageKey` (es la key de R2, no algo que el cliente deba ver) ni
 * `createdAt` (sólo sirve para el cursor, que ya va codificado).
 */
export interface CatalogoVista {
  id: string
  businessName: string
  category: CategoriaVista
  specialty: string | null
  currency: string
  priceFrom: string | null
  /** Primera foto del portfolio, prefirmada y de vida corta; `null` sin fotos o sin almacenamiento. */
  imageUrl: string | null
}

@Injectable()
export class SearchVendorCatalogUseCase {
  /**
   * `SubidaDeImagenes` es lo mismo que inyecta `GetPublicVendorProfileUseCase`
   * para firmar: `StorageModule` lo exporta como su puerto público, así que
   * aquí no entra nada de `storage/infrastructure`.
   */
  constructor(
    @Inject(VENDOR_CATALOG_REPOSITORY) private readonly catalogo: VendorCatalogRepository,
    private readonly imagenes: SubidaDeImagenes,
  ) {}

  /**
   * Solo búsqueda: el marketplace completo (reseñas, ubicación) queda fuera de
   * alcance. Las URLs se firman aquí y no en el repositorio porque caducan:
   * firmar es decidir cuándo se va a pintar, y eso es del caso de uso. Las
   * firmas de la página van en paralelo (`Promise.all` conserva el orden).
   */
  async ejecutar(busqueda: BusquedaCatalogo): Promise<CursorPage<CatalogoVista>> {
    const pagina = await this.catalogo.buscar(busqueda)
    return {
      items: await Promise.all(pagina.items.map((perfil) => this.aVista(perfil))),
      nextCursor: pagina.nextCursor,
    }
  }

  private async aVista(perfil: PerfilDeCatalogo): Promise<CatalogoVista> {
    return {
      id: perfil.id,
      businessName: perfil.businessName,
      category: perfil.category,
      specialty: perfil.specialty,
      currency: perfil.currency,
      priceFrom: perfil.priceFrom,
      imageUrl:
        perfil.imageKey === null ? null : await this.imagenes.firmarLectura(perfil.imageKey),
    }
  }
}
