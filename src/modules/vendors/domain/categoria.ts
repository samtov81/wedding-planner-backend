import { UnprocessableError } from '@/shared/domain'

/**
 * Categoría del catálogo cerrado (`vendor_categories`). `slug` es el
 * identificador público y estable: la API escribe y filtra por él. `name` es
 * lo que se muestra. El `id` no sale de la aplicación.
 */
export interface CategoriaDeProveedor {
  id: string
  slug: string
  name: string
}

export type CategoriaVista = Pick<CategoriaDeProveedor, 'slug' | 'name'>

export function aCategoriaVista(categoria: CategoriaVista): CategoriaVista {
  return { slug: categoria.slug, name: categoria.name }
}

/** Minúsculas, dígitos y guiones simples: `decor-floral`. */
// eslint-disable-next-line security/detect-unsafe-regex -- cada repetición empieza por un `-` obligatorio: no hay dos formas de casar la misma cadena, y la entrada va acotada a 50 caracteres
export const FORMATO_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** No existe o está desactivada: en ambos casos no se puede elegir. */
export class CategoriaDesconocidaError extends UnprocessableError {
  constructor() {
    super('Esa categoría de proveedor no existe', 'VENDOR_CATEGORY_UNKNOWN')
  }
}
