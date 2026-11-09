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

export interface NotaDeMoodboard {
  id: string
  imageId: string
  body: string
  createdAt: Date
  author: { id: string; name: string; avatarKey: string | null }
}

export interface Colaborador {
  userId: string
  name: string
  avatarKey: string | null
  role: 'COUPLE' | 'PLANNER' | 'VENDOR'
  /** `Couple`, `Planner` o la(s) categoría(s) de la contratación, unidas con ` · `. */
  label: string
}

export interface ActividadDeMoodboard {
  kind: 'image' | 'note'
  imageId: string
  actorName: string
  categoryName: string
  at: Date
}

/** Resumen sin `online`: la presencia vive en Redis y la añade el caso de uso. */
export interface ResumenCrudo {
  stats: { images: number; notes: number }
  activity: ActividadDeMoodboard[]
  collaborators: Colaborador[]
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
 *
 * Todas las lecturas son conscientes de la transacción: dentro de una
 * `UnidadDeTrabajo` ven las escrituras aún sin confirmar de esa misma unidad
 * (p. ej. `proveedoresQueVen` justo después de `fijarComparticion`).
 */
export interface MoodboardRepository {
  /** `SELECT … FOR UPDATE` de la fila del evento + cuenta de TODAS sus imágenes. Dentro de UnidadDeTrabajo. */
  bloquearYContar(eventId: string): Promise<number>
  /**
   * `SELECT … FOR UPDATE` de la fila de la foto (de ese evento). Dentro de
   * UnidadDeTrabajo, como PRIMERA sentencia de archivar, compartir y escribir
   * nota. Sin nada que bloquear (no existe o es de otro evento) no hace nada:
   * el `buscarImagen` que sigue da el 404.
   *
   * Por qué: esas tres escrituras comparten el invariante "una foto archivada
   * no tiene comparticiones nuevas ni notas nuevas" (y `ocultarA` de archivar
   * depende de las comparticiones vigentes). En READ COMMITTED, sin bloqueo,
   * una nota o compartición que leyó `archivedAt = null` antes de que un
   * archivado concurrente confirmara escribiría sobre una foto ya archivada,
   * sonaría una campana que lleva a un 404 y el archivado no ocultaría a ese
   * proveedor; dos comparticiones concurrentes de la misma contratación
   * llegarían las dos al upsert y la perdedora daría P2002 (500). Con el
   * bloqueo, la segunda espera y relee el estado confirmado.
   *
   * Por qué la fila de la FOTO y no la del evento (como `bloquearYContar`):
   * serializa exactamente las escrituras que comparten el invariante, sin
   * frenar las subidas ni las acciones sobre el resto de fotos del tablero.
   */
  bloquearImagen(eventId: string, imageId: string): Promise<void>
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
  /** Notas de la foto en orden cronológico (`createdAt asc, id asc`). La visibilidad de la foto la decide el caso de uso. */
  listarNotas(imageId: string): Promise<NotaDeMoodboard[]>
  crearNota(imageId: string, authorId: string, body: string): Promise<NotaDeMoodboard>
  /**
   * Resumen sobre lo que el visor VE (fotos activas; proveedor: las compartidas
   * con él, por la misma regla que el resto de lecturas). `activity`: las 10
   * más recientes entre alta de foto y nota, más reciente primero.
   * `collaborators`: miembros ACTIVE + (miembro: proveedores con alguna foto
   * activa compartida vigente; proveedor: él mismo), orden COUPLE, PLANNER,
   * VENDOR y por nombre. Un ADMIN sin membresía no es colaborador.
   * El `label` de un proveedor reúne TODAS sus contrataciones BOOKED del evento
   * (no sólo las que hoy llevan una foto compartida). El proveedor figura
   * siempre en su propia lista; para un miembro, los proveedores sólo
   * aparecen mientras el evento está ACTIVE: un proveedor no tiene acceso a un
   * evento que no lo está, y listarlo expondría a quien no puede entrar.
   */
  resumen(eventId: string, visor: Visor): Promise<ResumenCrudo>
  /**
   * A quién avisar de una nota: quien subió la foto + autores de notas + los
   * proveedores que la ven, FILTRADOS por quién la ve hoy (miembro ACTIVE del
   * evento o proveedor que la ve), sin `excluir`. Un proveedor revocado que
   * escribió antes y un miembro REVOKED no entran.
   */
  participantes(imageId: string, excluir: string): Promise<string[]>
}

export const MOODBOARD_REPOSITORY = Symbol('MOODBOARD_REPOSITORY')
