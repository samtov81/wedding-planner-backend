import type {
  DatosDeFicha,
  EstadoDeFicha,
  FichaDeProveedor,
  FotoDePortfolio,
} from '../domain/vendor-profile'

export interface NuevoPaquete {
  name: string
  description: string
  price: string
}

/**
 * La ficha de marketplace de un usuario. Las escrituras que dependen de lo
 * que hay (límite de fotos, reordenar) corren en una unidad de trabajo tras
 * `bloquearFicha`, y por eso el adaptador escribe con `clienteDe`.
 */
export interface VendorProfileRepository {
  buscarPorUsuario(userId: string): Promise<FichaDeProveedor | null>
  /** Sólo si está PUBLISHED: lo que ve cualquiera. */
  buscarPublicada(id: string): Promise<FichaDeProveedor | null>
  /** Alta (en DRAFT) o edición de los datos escritos por el proveedor. */
  guardarDatos(userId: string, datos: DatosDeFicha): Promise<FichaDeProveedor>
  fijarEstado(fichaId: string, estado: EstadoDeFicha): Promise<void>
  bloquearFicha(fichaId: string): Promise<void>
  /** Sustituye todos los paquetes, en el orden dado. */
  reemplazarPaquetes(fichaId: string, paquetes: NuevoPaquete[]): Promise<void>
  /** La añade al final del portfolio. */
  agregarFoto(fichaId: string, foto: { storageKey: string; alt: string }): Promise<FotoDePortfolio>
  /** `false` si la foto no es de esa ficha. */
  cambiarAlt(fichaId: string, fotoId: string, alt: string): Promise<boolean>
  /** Devuelve la key de R2 de la foto borrada, o `null` si no era de esa ficha. */
  borrarFoto(fichaId: string, fotoId: string): Promise<string | null>
  /** `ids` es exactamente el conjunto actual (lo comprueba el caso de uso). */
  reordenarFotos(fichaId: string, ids: string[]): Promise<void>
  /** Eventos distintos en los que la ficha está BOOKED. */
  contarBodas(fichaId: string): Promise<number>
  /** Otras fichas PUBLISHED de la misma categoría (sin distinguir mayúsculas). */
  similares(ficha: { id: string; category: string }, limite: number): Promise<FichaDeProveedor[]>
}

export const VENDOR_PROFILE_REPOSITORY = Symbol('VENDOR_PROFILE_REPOSITORY')
