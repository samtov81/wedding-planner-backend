import type { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'

import {
  type Contacto,
  type EstadoDeFicha,
  type FichaDeProveedor,
  precioDesde,
} from '../domain/vendor-profile'
import type { Ubicacion } from '@/shared/domain'

import { aCategoriaVista, type CategoriaVista } from '../domain/categoria'

export interface FotoVista {
  id: string
  alt: string
  /** Prefirmada y de vida corta; `null` sin almacenamiento. */
  url: string | null
}

export interface PaqueteVista {
  id: string
  name: string
  description: string
  price: string
}

/** La ficha tal como se pinta, para su dueño o para cualquiera. */
export interface FichaVista {
  id: string
  status: EstadoDeFicha
  /** Avatar del dueño, prefirmado; `null` sin avatar o sin almacenamiento. */
  avatarUrl: string | null
  businessName: string
  category: CategoriaVista
  specialty: string | null
  tagline: string | null
  bio: string | null
  quote: string | null
  yearsExperience: number | null
  responseTime: string | null
  currency: string
  publications: string[]
  contact: Contacto
  location: Ubicacion | null
  packages: PaqueteVista[]
  portfolio: FotoVista[]
  /** Derivado: el paquete más barato. */
  priceFrom: string | null
  /** Derivado: eventos distintos donde está BOOKED. */
  weddingsCount: number
}

export interface SimilarVista {
  id: string
  businessName: string
  category: CategoriaVista
  specialty: string | null
  currency: string
  priceFrom: string | null
  /** Primera foto del portfolio. */
  imageUrl: string | null
}

export async function aFotos(
  ficha: Pick<FichaDeProveedor, 'portfolio'>,
  imagenes: Pick<SubidaDeImagenes, 'firmarLectura'>,
): Promise<FotoVista[]> {
  return await Promise.all(
    ficha.portfolio.map(async (f) => ({
      id: f.id,
      alt: f.alt,
      url: await imagenes.firmarLectura(f.storageKey),
    })),
  )
}

export async function aVista(
  ficha: FichaDeProveedor,
  imagenes: Pick<SubidaDeImagenes, 'firmarLectura'>,
  weddingsCount: number,
): Promise<FichaVista> {
  return {
    id: ficha.id,
    status: ficha.status,
    avatarUrl: ficha.avatarKey === null ? null : await imagenes.firmarLectura(ficha.avatarKey),
    businessName: ficha.businessName,
    category: aCategoriaVista(ficha.category),
    specialty: ficha.specialty,
    tagline: ficha.tagline,
    bio: ficha.bio,
    quote: ficha.quote,
    yearsExperience: ficha.yearsExperience,
    responseTime: ficha.responseTime,
    currency: ficha.currency,
    publications: ficha.publications,
    contact: ficha.contact,
    location: ficha.location,
    packages: ficha.packages.map((p) => ({ ...p })),
    portfolio: await aFotos(ficha, imagenes),
    priceFrom: precioDesde(ficha.packages),
    weddingsCount,
  }
}

export async function aSimilar(
  ficha: FichaDeProveedor,
  imagenes: Pick<SubidaDeImagenes, 'firmarLectura'>,
): Promise<SimilarVista> {
  const primera = ficha.portfolio[0]
  return {
    id: ficha.id,
    businessName: ficha.businessName,
    category: aCategoriaVista(ficha.category),
    specialty: ficha.specialty,
    currency: ficha.currency,
    priceFrom: precioDesde(ficha.packages),
    imageUrl: primera === undefined ? null : await imagenes.firmarLectura(primera.storageKey),
  }
}
