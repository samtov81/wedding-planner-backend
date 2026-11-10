import type { Logger } from '@nestjs/common'

import type { TIPO_MOODBOARD_IMAGEN_COMPARTIDA } from '@/modules/notifications/application/notification.port'
import type { QueueName, QueuePort } from '@/modules/queue/application/queue.port'

/**
 * Contrato de los avisos en tiempo real del moodboard (spec 2026-11-09 §7). Lo
 * PRODUCEN los casos de uso (crear, archivar, compartir, escribir nota) y lo
 * consume el worker de `interfaces/` (Task 7), que emite al socket.
 *
 * Cola PROPIA, `moodboard` (ruling C17, igual que `messaging`): un worker que
 * toma un job y retorna lo marca completado, así que compartir cola con otro
 * worker le comería los jobs.
 *
 * El job lleva ids y LISTAS DE USUARIOS ya decididas, no fotos ni notas:
 *  - `ocultarA`: proveedores que DEJARON de ver la foto con este cambio. Sólo
 *    el caso de uso lo sabe (después del cambio ya no hay forma de leerlo), así
 *    que va en el job; el worker les emite `moodboard.image.hidden`.
 *  - `campanaA` + `tipoCampana`: a quién se le creó una campana dentro de la
 *    transacción, para que el worker emita `notification.created`. La fila ya
 *    está confirmada; el socket sólo adelanta lo que se verá al recargar.
 * Quién VE la foto ahora (para `image.changed` / `note.created`) NO va en el
 * job: el worker lo lee del estado actual (`proveedoresQueVen`), así un
 * proveedor revocado entre el encolado y el consumo no recibe nada.
 * Alternativa descartada: congelar también los destinatarios de `changed` en
 * el job, que emitiría a quien ya perdió el acceso.
 *
 * El aviso es latencia sobre un estado que ya está en la base: se encola
 * DESPUÉS del commit y un fallo de Redis se registra y NO se propaga.
 */
export const COLA_MOODBOARD = 'moodboard' satisfies QueueName

/** Nombres de job y, a la vez, de evento de socket. */
export const EVENTO_IMAGEN_CAMBIADA = 'moodboard.image.changed'
export const EVENTO_IMAGEN_OCULTA = 'moodboard.image.hidden'
export const EVENTO_NOTA_CREADA = 'moodboard.note.created'

export interface JobImagenCambiada {
  eventId: string
  imageId: string
  /** userId de los proveedores que dejaron de ver la foto (revocada o archivada). */
  ocultarA: string[]
  /** userId a los que se les creó una campana en este cambio (alta de compartición). */
  campanaA: string[]
  tipoCampana: typeof TIPO_MOODBOARD_IMAGEN_COMPARTIDA | null
}

export interface JobNotaCreada {
  eventId: string
  imageId: string
  noteId: string
  /** userId a los que se les creó la campana `moodboard.note.added`. */
  campanaA: string[]
}

/**
 * Una foto cambia muchas veces (archivar, recuperar, compartir…) y cada cambio
 * lleva su propio `ocultarA`, así que el id NO puede derivarse sólo de la foto:
 * BullMQ descartaría el segundo aviso y su `ocultarA` se perdería (un
 * proveedor seguiría viendo una foto revocada hasta recargar). Se le añade la
 * hora en ms. Con un `Date.now()` a secas, dos cambios de la misma foto en el
 * mismo milisegundo chocarían (los tests de casos de uso lo reproducen); por
 * eso la marca es ESTRICTAMENTE creciente dentro del proceso: si el reloj no
 * avanzó, se toma la anterior + 1. Entre réplicas distintas sigue siendo
 * posible un choque en el mismo ms sobre la misma foto, que exige dos
 * peticiones simultáneas de dos miembros a dos pods: se acepta, y el cliente
 * se corrige al recargar. Alternativa descartada: un uuid por llamada, que no
 * choca nunca pero deja de ser el formato del contrato
 * (`moodboard-img-<imageId>-<epochMs>`) y no dice cuándo se encoló.
 * Con `-`, nunca `:` (ver `EnqueueOptions.jobId`).
 */
export const jobIdDeImagen = (imageId: string, epochMs: number): string =>
  `moodboard-img-${imageId}-${epochMs}`

let ultimaMarca = 0

/** `Date.now()`, pero nunca igual ni menor que la marca anterior de este proceso. */
function marcaCreciente(): number {
  ultimaMarca = Math.max(Date.now(), ultimaMarca + 1)
  return ultimaMarca
}

/** Único por nota: reencolarla no duplica el aviso. */
export const jobIdDeNota = (noteId: string): string => `moodboard-note-${noteId}`

async function encolarSinPropagar(
  registro: Logger,
  que: string,
  imageId: string,
  encolar: () => Promise<void>,
): Promise<void> {
  try {
    await encolar()
  } catch (error) {
    registro.warn(
      `${que} guardado pero su aviso no se pudo encolar imageId=${imageId}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }
}

/** Cuando se llama, el cambio ya está confirmado: un fallo de Redis sólo se avisa. */
export function encolarAvisoImagen(
  cola: QueuePort,
  registro: Logger,
  job: JobImagenCambiada,
): Promise<void> {
  return encolarSinPropagar(registro, 'Cambio de imagen', job.imageId, () =>
    cola.enqueue(COLA_MOODBOARD, EVENTO_IMAGEN_CAMBIADA, job, {
      jobId: jobIdDeImagen(job.imageId, marcaCreciente()),
    }),
  )
}

/** Cuando se llama, la nota ya está confirmada: un fallo de Redis sólo se avisa. */
export function encolarAvisoNota(
  cola: QueuePort,
  registro: Logger,
  job: JobNotaCreada,
): Promise<void> {
  return encolarSinPropagar(registro, 'Nota', job.imageId, () =>
    cola.enqueue(COLA_MOODBOARD, EVENTO_NOTA_CREADA, job, { jobId: jobIdDeNota(job.noteId) }),
  )
}
