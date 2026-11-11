import type { Logger } from '@nestjs/common'

import type { QueueName, QueuePort } from '@/modules/queue/application/queue.port'

import { debeProgramarse, momentoDelRecordatorio } from '../domain/participacion'

/**
 * Contrato de la cola del cronograma (spec 2026-11-10 §4–§6). Lo PRODUCEN los
 * casos de uso (crear, editar, asignar, "Notify Vendors") y la recontratación;
 * lo consume el worker de `interfaces/` (Task 6).
 *
 * Cola PROPIA, `schedule` (ruling C17, igual que `moodboard`): un worker que
 * toma un job y retorna lo marca completado, así que compartir cola con otro
 * worker le comería los jobs.
 *
 * Dos clases de job:
 *  - `schedule.item.reminder`: DIFERIDO hasta `startsAt − 15 min`. Lleva la
 *    hora con la que se encoló; el worker relee el estado y descarta el job si
 *    ya no coincide (`debeAvisar`). Nunca se borra un job (spec §5): con A→B→A
 *    los dos jobs de la hora A comparten jobId y BullMQ deja uno.
 *  - `schedule.bell`: empuje en vivo de una campana YA creada dentro de la
 *    transacción. La fila está confirmada; el socket sólo adelanta lo que se
 *    verá al recargar.
 *
 * Ambos se encolan DESPUÉS del commit y un fallo de Redis se registra y NO se
 * propaga: el cambio ya está guardado y deshacerlo por un aviso sería peor.
 * Alternativa descartada: encolar dentro de la transacción, que dejaría jobs
 * de cambios que luego se deshacen (y el worker avisaría de algo que no pasó).
 */
export const COLA_CRONOGRAMA = 'schedule' satisfies QueueName

/** Nombre del job del recordatorio (coincide con el tipo de campana que crea). */
export const EVENTO_RECORDATORIO = 'schedule.item.reminder'

/** Nombre del job de empuje en vivo de una campana ya persistida. */
export const EVENTO_CAMPANA = 'schedule.bell'

export interface JobRecordatorio {
  itemId: string
  eventVendorId: string
  /** ISO 8601: la hora del ítem cuando se encoló. */
  startsAt: string
}

export interface JobCampana {
  eventId: string
  /** Tipo de la `Notification` ya creada (`schedule.item.rescheduled`…). */
  tipo: string
  /** A quién se le creó la fila, para emitir `notification.created` a `user:<id>`. */
  userIds: string[]
}

/** Una asignación a la que programar su recordatorio, con la hora vigente del ítem. */
export interface AsignacionAProgramar {
  itemId: string
  eventVendorId: string
  startsAt: Date
}

/**
 * Determinista por (ítem, contratación, hora): reencolar la misma hora es
 * idempotente y otra hora es otro job (spec 2026-11-10 §5). Con `-`, nunca
 * `:` (ver `EnqueueOptions.jobId`).
 */
export const jobIdDeRecordatorio = (
  itemId: string,
  eventVendorId: string,
  startsAt: Date,
): string => `reminder-${itemId}-${eventVendorId}-${startsAt.getTime()}`

let ultimaMarca = 0

/**
 * `Date.now()`, pero nunca igual ni menor que la marca anterior de este
 * proceso: dos campanas del mismo tipo y evento en el mismo ms (dos cambios
 * de hora seguidos) son DOS avisos y BullMQ descartaría el segundo con un
 * jobId repetido. Mismo razonamiento que `marcaCreciente` del moodboard.
 */
function marcaCreciente(): number {
  ultimaMarca = Math.max(Date.now(), ultimaMarca + 1)
  return ultimaMarca
}

function motivo(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Encola el recordatorio de cada asignación cuyo momento (`startsAt − 15 min`)
 * aún no ha pasado; el resto no se programa (spec 2026-11-10 §5). Nunca lanza.
 *
 * Al PRIMER fallo de Redis se deja de intentar: se registra UNA vez, con
 * cuántos quedaron sin encolar, y se vuelve. Con Redis caído cada `enqueue`
 * espera su propio timeout de conexión, así que seguir con los N restantes
 * dejaría colgada N veces la petición HTTP que ya guardó el cambio (un
 * "Notify Vendors" o una asignación de 50 proveedores). Lo que se omite no se
 * pierde: el barrido periódico (`ReconstruirRecordatorios`) lo repone en
 * cuanto Redis vuelve. Alternativa descartada: seguir job a job, que sólo
 * acierta si el fallo es de UN job y no de la conexión, el caso raro.
 */
export async function encolarRecordatorios(
  cola: QueuePort,
  registro: Logger,
  asignaciones: readonly AsignacionAProgramar[],
  ahora: Date,
): Promise<void> {
  const programables = asignaciones.filter((a) => debeProgramarse(a.startsAt, ahora))
  for (const [indice, a] of programables.entries()) {
    const job: JobRecordatorio = {
      itemId: a.itemId,
      eventVendorId: a.eventVendorId,
      startsAt: a.startsAt.toISOString(),
    }
    try {
      await cola.enqueue(COLA_CRONOGRAMA, EVENTO_RECORDATORIO, job, {
        jobId: jobIdDeRecordatorio(a.itemId, a.eventVendorId, a.startsAt),
        delayMs: momentoDelRecordatorio(a.startsAt).getTime() - ahora.getTime(),
      })
    } catch (error) {
      const omitidos = programables.length - indice - 1
      registro.warn(
        `Recordatorio no encolado itemId=${a.itemId} eventVendorId=${a.eventVendorId}; ` +
          `se omiten ${omitidos} más hasta el próximo barrido: ` +
          motivo(error),
      )
      return
    }
  }
}

/** Cuando se llama, la campana ya está confirmada: un fallo de Redis sólo se avisa. */
export async function encolarCampana(
  cola: QueuePort,
  registro: Logger,
  job: JobCampana,
): Promise<void> {
  try {
    await cola.enqueue(COLA_CRONOGRAMA, EVENTO_CAMPANA, job, {
      jobId: `bell-${job.tipo}-${job.eventId}-${marcaCreciente()}`,
    })
  } catch (error) {
    registro.warn(
      `Campana ${job.tipo} guardada pero su aviso no se pudo encolar eventId=${job.eventId}: ` +
        motivo(error),
    )
  }
}
