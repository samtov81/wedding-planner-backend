import type { EventAccess } from '@/modules/events/domain/event-access'

import type {
  ContratacionCompartible,
  ImagenDeMoodboard,
  NotaDeMoodboard,
  ResumenCrudo,
} from '../application/moodboard.repository'
import type { Visor } from '../domain/moodboard'

/**
 * Traduce el acceso que `EventAccessGuard` ya resolvió al `Visor` del dominio
 * del moodboard. Vive en `interfaces/` y no en `domain/`: el dominio de un
 * módulo no importa el de otro (`events/domain`).
 *
 * `vendor` → proveedor; `member` y `admin` → miembro (un ADMIN ve el tablero
 * como quien lo planifica). Sin acceso, o con `none`, la ruta perdió su guard
 * o el guard dejó pasar a quien no debía: error de programación (500), como
 * `actorDe` en `schedule.controller.ts`, nunca un permiso concedido.
 */
export function visorDe(acceso: EventAccess | undefined, userId: string): Visor {
  if (acceso === undefined || acceso.kind === 'none') {
    throw new Error('MoodboardController requires EventAccessGuard')
  }
  return acceso.kind === 'vendor' ? { tipo: 'proveedor', userId } : { tipo: 'miembro', userId }
}

export interface ImageJson {
  id: string
  title: string
  url: string | null
  width: number
  height: number
  category: { id: string; slug: string; name: string }
  uploadedBy: { id: string; name: string }
  createdAt: string
  archivedAt: string | null
  noteCount: number
  /** SÓLO para miembros: a un proveedor no se le dice con quién más se compartió. */
  sharedWith?: { eventVendorId: string; name: string }[]
}

export interface NoteJson {
  id: string
  imageId: string
  body: string
  createdAt: string
  author: { id: string; name: string; avatarUrl: string | null }
}

export interface SummaryJson {
  stats: { images: number; notes: number }
  activity: {
    kind: 'image' | 'note'
    imageId: string
    actorName: string
    categoryName: string
    at: string
  }[]
  collaborators: {
    userId: string
    name: string
    avatarUrl: string | null
    role: 'COUPLE' | 'PLANNER' | 'VENDOR'
    label: string
    online: boolean
  }[]
}

export interface ShareableVendorJson {
  eventVendorId: string
  name: string
  categoryName: string
}

/**
 * `url` llega ya firmada (`SubidaDeImagenes.firmarLectura(storageKey)`); la
 * `storageKey` no sale nunca. `sharedWith` se OMITE (no se manda vacío) si
 * quien mira no es miembro: el contrato la declara opcional por eso.
 */
export function imagenJson(
  imagen: ImagenDeMoodboard,
  url: string | null,
  esMiembro: boolean,
): ImageJson {
  const json: ImageJson = {
    id: imagen.id,
    title: imagen.title,
    url,
    width: imagen.width,
    height: imagen.height,
    category: { ...imagen.category },
    uploadedBy: { ...imagen.uploadedBy },
    createdAt: imagen.createdAt.toISOString(),
    archivedAt: imagen.archivedAt?.toISOString() ?? null,
    noteCount: imagen.noteCount,
  }
  if (esMiembro) json.sharedWith = imagen.sharedWith.map((s) => ({ ...s }))
  return json
}

/** `avatarUrl` llega firmada desde `author.avatarKey`, como el perfil de `users`. */
export function notaJson(nota: NotaDeMoodboard, avatarUrl: string | null): NoteJson {
  return {
    id: nota.id,
    imageId: nota.imageId,
    body: nota.body,
    createdAt: nota.createdAt.toISOString(),
    author: { id: nota.author.id, name: nota.author.name, avatarUrl },
  }
}

/**
 * `avatarUrls` va indexado por `userId` (firmado por el controlador);
 * `online` sale del conjunto que el caso de uso leyó de la presencia.
 */
export function resumenJson(
  resumen: ResumenCrudo & { online: Set<string> },
  avatarUrls: Map<string, string | null>,
): SummaryJson {
  return {
    stats: { ...resumen.stats },
    activity: resumen.activity.map((a) => ({
      kind: a.kind,
      imageId: a.imageId,
      actorName: a.actorName,
      categoryName: a.categoryName,
      at: a.at.toISOString(),
    })),
    collaborators: resumen.collaborators.map((c) => ({
      userId: c.userId,
      name: c.name,
      avatarUrl: avatarUrls.get(c.userId) ?? null,
      role: c.role,
      label: c.label,
      online: resumen.online.has(c.userId),
    })),
  }
}

/** Sin `userId`: el puerto lo lleva para los avisos, el cliente no lo necesita. */
export function compartibleJson(c: ContratacionCompartible): ShareableVendorJson {
  return { eventVendorId: c.eventVendorId, name: c.name, categoryName: c.categoryName }
}
