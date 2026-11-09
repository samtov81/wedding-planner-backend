import type { Visor } from '../domain/moodboard'

export interface ImagenDeMoodboard {
  id: string
  eventId: string
  title: string
  storageKey: string
  width: number
  height: number
  category: { id: string; slug: string; name: string }
  uploadedBy: { id: string; name: string }
  createdAt: Date
  archivedAt: Date | null
  noteCount: number
  /** Comparticiones vigentes; el controlador sólo la publica a miembros. */
  sharedWith: { eventVendorId: string; name: string }[]
}

export interface DatosNuevaImagen {
  eventId: string
  categoryId: string
  title: string
  storageKey: string
  width: number
  height: number
  uploadedById: string
}

export interface ContratacionCompartible {
  eventVendorId: string
  name: string
  categoryName: string
  userId: string
}

/**
 * Puerto de fotos y comparticiones del moodboard.
 *
 * Visibilidad de proveedor (la decide el repositorio, no el caso de uso, para
 * que doble y Prisma no puedan divergir): existe un `MoodboardShare` vigente
 * (`revokedAt` nulo) cuyo `EventVendor` es `BOOKED`, del mismo evento y con
 * `vendorProfile.userId` = visor, el evento está `ACTIVE` y la foto no está
 * archivada. Es la UNIÓN de todas sus contrataciones (spec 2026-11-09 §4):
 * alternativa descartada, apoyarse en el `eventVendorId` de `EventAccess`, que
 * es uno arbitrario (`findFirst`) y ocultaría las fotos de la otra contratación.
 */
export interface MoodboardRepository {
  /** `SELECT … FOR UPDATE` de la fila del evento + cuenta de TODAS sus imágenes. Dentro de UnidadDeTrabajo. */
  bloquearYContar(eventId: string): Promise<number>
  categoriaActiva(categoryId: string): Promise<boolean>
  crearImagen(datos: DatosNuevaImagen): Promise<ImagenDeMoodboard>
  /** `createdAt desc, id desc`. `archivadas = true` con visor proveedor devuelve `[]`. */
  listarImagenes(eventId: string, visor: Visor, archivadas: boolean): Promise<ImagenDeMoodboard[]>
  /** null si no existe en ese evento o el visor no la ve (proveedor: compartida vigente y activa). */
  buscarImagen(eventId: string, imageId: string, visor: Visor): Promise<ImagenDeMoodboard | null>
  fijarArchivo(imageId: string, por: string | null): Promise<void>
  /** `BOOKED` con ficha de la plataforma, ordenadas por nombre. */
  listarCompartibles(eventId: string): Promise<ContratacionCompartible[]>
  /** Altas crean o reavivan (revokedAt = null); bajas ponen revokedAt. Devuelve los eventVendorId de cada lado. */
  fijarComparticion(
    imageId: string,
    eventVendorIds: string[],
    por: string,
  ): Promise<{ altas: string[]; bajas: string[] }>
  /** userId de las fichas de esas contrataciones (para avisos). */
  usuariosDeContrataciones(eventVendorIds: string[]): Promise<string[]>
  /** userId de los proveedores que HOY ven la foto (compartida vigente, activa, BOOKED, evento ACTIVE). */
  proveedoresQueVen(imageId: string): Promise<string[]>
}

export const MOODBOARD_REPOSITORY = Symbol('MOODBOARD_REPOSITORY')
