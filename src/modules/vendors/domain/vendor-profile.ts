import { aCentimos, type Ubicacion } from '@/shared/domain'

export type EstadoDeFicha = 'DRAFT' | 'PUBLISHED' | 'SUSPENDED'

export interface Contacto {
  email: string | null
  phone: string | null
  website: string | null
}

export interface Paquete {
  id: string
  name: string
  description: string
  /** Monto normalizado ("4500.00") en la moneda de la ficha. */
  price: string
}

export interface FotoDePortfolio {
  id: string
  storageKey: string
  alt: string
}

/** Lo que el proveedor escribe de su ficha (todo menos estado, paquetes y fotos). */
export interface DatosDeFicha {
  businessName: string
  category: string
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
}

export interface FichaDeProveedor extends DatosDeFicha {
  id: string
  userId: string
  status: EstadoDeFicha
  /** Avatar del perfil personal del dueño: la foto de la ficha es la suya. */
  avatarKey: string | null
  /** En el orden en que se muestran. */
  packages: Paquete[]
  portfolio: FotoDePortfolio[]
}

export const MAX_FOTOS_PORTFOLIO = 20
export const MAX_PAQUETES = 20
export const MAX_PUBLICACIONES = 20
/** Cuántos "Similar vendors" enseña la ficha pública. */
export const MAX_SIMILARES = 4

/** Carpeta de R2 del portfolio de un usuario. */
export function prefijoDePortfolio(userId: string): string {
  return `users/${userId}/portfolio`
}

/**
 * El switch "soy proveedor": encendido publica, apagado oculta. Una ficha
 * SUSPENDED la gestiona la plataforma, no su dueño: el switch no la mueve.
 * Nombre y categoría (lo único obligatorio para publicar) ya los garantiza
 * que la ficha exista: son NOT NULL y el alta los exige.
 */
export function estadoAlCambiarModo(actual: EstadoDeFicha, activo: boolean): EstadoDeFicha | null {
  if (actual === 'SUSPENDED') return null
  return activo ? 'PUBLISHED' : 'DRAFT'
}

/** "Pricing From": el paquete más barato, o `null` sin paquetes. */
export function precioDesde(paquetes: readonly Pick<Paquete, 'price'>[]): string | null {
  let minimo: string | null = null
  for (const { price } of paquetes) {
    if (minimo === null || aCentimos(price) < aCentimos(minimo)) minimo = price
  }
  return minimo
}
