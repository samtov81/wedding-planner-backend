import type { Ubicacion } from '@/shared/domain'

import type { ItemDelListado } from '../application/list-schedule-items.use-case'
import type { EstadoDeConfirmaciones } from '../application/participacion.use-cases'
import type { Asignable, NotaDeItem } from '../application/schedule-item.repository'
import type { ScheduleItemStatus } from '../domain/schedule-item'

/**
 * Forma JSON de las respuestas del cronograma (contrato de la Task 8, spec
 * 2026-11-10). Funciones puras: las URLs de avatar llegan YA firmadas por el
 * controlador (`SubidaDeImagenes.firmarLectura`), como en `moodboard.json.ts`,
 * y ninguna `avatarKey` sale nunca.
 */

export interface ItemJson {
  id: string
  eventId: string
  title: string
  description: string | null
  startsAt: string
  endsAt: string | null
  location: Ubicacion | null
  status: ScheduleItemStatus
  vendors: { eventVendorId: string; name: string; categoryName: string; confirmed: boolean }[]
  /** SÓLO para el planner (spec 2026-11-10 §7): para los demás la clave no existe. */
  noteCount?: number
}

export interface NoteJson {
  id: string
  itemId: string
  body: string
  createdAt: string
  author: { id: string; name: string; avatarUrl: string | null }
}

export interface AssignableVendorJson {
  eventVendorId: string
  name: string
  categoryName: string
}

export interface ConfirmacionesJson {
  ready: number
  total: number
  vendors: { userId: string; name: string; avatarUrl: string | null; ready: boolean }[]
  mine: { pending: { itemId: string; startsAt: string; endsAt: string | null }[] } | null
}

/**
 * `noteCount` se copia SÓLO si el caso de uso lo puso (el listado del
 * planner): se OMITE la clave, no se manda `0` ni `undefined`, porque para
 * quien no es planner las notas no existen. Las respuestas de crear, editar y
 * asignar no lo llevan aunque las pida el planner: el caso de uso no lo
 * calcula ahí, y el cliente conserva el que ya tenía del listado.
 * `createdAt`/`updatedAt` no salen, como antes de esta tarea.
 */
export function itemJson(item: ItemDelListado): ItemJson {
  const json: ItemJson = {
    id: item.id,
    eventId: item.eventId,
    title: item.title,
    description: item.description,
    startsAt: item.startsAt.toISOString(),
    endsAt: item.endsAt?.toISOString() ?? null,
    location: item.location,
    status: item.status,
    vendors: item.vendors.map((v) => ({
      eventVendorId: v.eventVendorId,
      name: v.name,
      categoryName: v.categoryName,
      confirmed: v.confirmed,
    })),
  }
  if (item.noteCount !== undefined) json.noteCount = item.noteCount
  return json
}

/** `avatarUrl` llega firmada desde `author.avatarKey`. */
export function notaJson(nota: NotaDeItem, avatarUrl: string | null): NoteJson {
  return {
    id: nota.id,
    itemId: nota.itemId,
    body: nota.body,
    createdAt: nota.createdAt.toISOString(),
    author: { id: nota.author.id, name: nota.author.name, avatarUrl },
  }
}

/** Sin `userId`: el puerto lo lleva para los avisos, el cliente no lo necesita. */
export function asignableJson(a: Asignable): AssignableVendorJson {
  return { eventVendorId: a.eventVendorId, name: a.name, categoryName: a.categoryName }
}

/** `avatarUrls` va indexado por `userId`, firmado por el controlador. */
export function confirmacionesJson(
  estado: EstadoDeConfirmaciones,
  avatarUrls: Map<string, string | null>,
): ConfirmacionesJson {
  return {
    ready: estado.ready,
    total: estado.total,
    vendors: estado.vendors.map((v) => ({
      userId: v.userId,
      name: v.name,
      avatarUrl: avatarUrls.get(v.userId) ?? null,
      ready: v.ready,
    })),
    mine:
      estado.mine === null
        ? null
        : {
            pending: estado.mine.pending.map((p) => ({
              itemId: p.itemId,
              startsAt: p.startsAt.toISOString(),
              endsAt: p.endsAt?.toISOString() ?? null,
            })),
          },
  }
}
