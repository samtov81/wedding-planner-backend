import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import { z } from 'zod'

import {
  NOTIFICACION_CREADA,
  REALTIME_PORT,
  type RealtimePort,
} from '@/modules/notifications/application/realtime.port'

import {
  COLA_MOODBOARD,
  EVENTO_IMAGEN_CAMBIADA,
  EVENTO_IMAGEN_OCULTA,
  EVENTO_NOTA_CREADA,
  type JobImagenCambiada,
  type JobNotaCreada,
} from '../application/avisos-moodboard'
import { MOODBOARD_REPOSITORY, type MoodboardRepository } from '../application/moodboard.repository'

/**
 * Lo que sale de Redis es ENTRADA (lo escribió otro proceso, quizá con otra
 * versión): se valida, y `satisfies` ata cada esquema al tipo que exporta el
 * productor, como en `MessagingProcessor`.
 */
const imagenCambiadaSchema = z.object({
  eventId: z.guid(),
  imageId: z.guid(),
  ocultarA: z.array(z.guid()),
  campanaA: z.array(z.guid()),
  tipoCampana: z.literal('moodboard.image.shared').nullable(),
}) satisfies z.ZodType<JobImagenCambiada>

const notaCreadaSchema = z.object({
  eventId: z.guid(),
  imageId: z.guid(),
  noteId: z.guid(),
  campanaA: z.array(z.guid()),
}) satisfies z.ZodType<JobNotaCreada>

function leer<T>(esquema: z.ZodType<T>, job: Job): T {
  const leido = esquema.safeParse(job.data)
  // Un payload roto no lo arregla ningún reintento. El mensaje no lleva el
  // payload: los ids de usuario no van a los jobs fallidos.
  if (!leido.success) throw new UnrecoverableError(`Payload inválido en el job ${job.name}`)
  return leido.data
}

/** Tipo de campana de una nota: fijo, el job no lo lleva (sólo hay uno). */
const CAMPANA_DE_NOTA = 'moodboard.note.added'

/**
 * Worker de la cola `moodboard` (spec 2026-11-09 §7). Emite al socket con
 * payload de IDS: el cliente vuelve a leer por REST, así un aviso nunca
 * filtra contenido a quien acaba de perder el acceso.
 *
 * Re-lee el estado ACTUAL antes de emitir, nunca se fía de las listas del job
 * para decidir quién VE la foto:
 *  - `image.changed` / `note.created` → sala `event:<id>` (quien planifica) y
 *    `user:<id>` de cada proveedor que HOY la ve (`proveedoresQueVen`).
 *  - `image.hidden` → cada `ocultarA` que, ahora, TODAVÍA no la ve. Un
 *    proveedor que perdió una contratación al encolar pero recuperó la foto
 *    por otra antes del consumo (unión de contrataciones, spec §4) no la
 *    oculta: su cliente la quitaría sin motivo.
 *  - `notification.created` → cada `campanaA` que aún la ve. La fila de la
 *    campana ya está confirmada y se verá al recargar; el socket sólo adelanta
 *    el número, y no se le adelanta a quien ya no puede abrir la foto (llevaría
 *    a un 404). En una foto, "la ve" es `proveedoresQueVen` (la campana de
 *    compartir sólo va a proveedores); en una nota, `participantes` re-leídos,
 *    que ya excluyen al proveedor revocado y al miembro REVOKED.
 * Alternativa descartada: emitir tal cual a las listas del job, que avisaría
 * a quien perdió el acceso entre el encolado y el consumo (Review Focus 5).
 *
 * Un nombre de job DESCONOCIDO falla con `UnrecoverableError` (retornar lo
 * marcaría completado y lo perdería en silencio). Los errores de emisión
 * SALEN, para que BullMQ reintente con la política común; un reintento puede
 * repetir emisiones ya hechas, que el cliente absorbe porque sólo relee.
 */
@Processor(COLA_MOODBOARD)
export class MoodboardProcessor extends WorkerHost {
  constructor(
    @Inject(MOODBOARD_REPOSITORY) private readonly repo: MoodboardRepository,
    @Inject(REALTIME_PORT) private readonly tiempoReal: RealtimePort,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case EVENTO_IMAGEN_CAMBIADA:
        await this.imagenCambiada(leer(imagenCambiadaSchema, job))
        return
      case EVENTO_NOTA_CREADA:
        await this.notaCreada(leer(notaCreadaSchema, job))
        return
      default:
        throw new UnrecoverableError(`Job desconocido en la cola moodboard: ${job.name}`)
    }
  }

  private async imagenCambiada(job: JobImagenCambiada): Promise<void> {
    const { eventId, imageId } = job
    const payload = { eventId, imageId }
    const laVen = new Set(await this.repo.proveedoresQueVen(imageId))

    await this.aEventoYProveedores(eventId, laVen, EVENTO_IMAGEN_CAMBIADA, payload)
    for (const userId of job.ocultarA) {
      if (laVen.has(userId)) continue
      await this.tiempoReal.emitirAUsuario(userId, EVENTO_IMAGEN_OCULTA, payload)
    }
    if (job.tipoCampana !== null) {
      await this.campana(eventId, job.campanaA, laVen, job.tipoCampana)
    }
  }

  private async notaCreada(job: JobNotaCreada): Promise<void> {
    const { eventId, imageId, noteId } = job
    const laVen = new Set(await this.repo.proveedoresQueVen(imageId))

    await this.aEventoYProveedores(eventId, laVen, EVENTO_NOTA_CREADA, {
      eventId,
      imageId,
      noteId,
    })
    // `campanaA` ya excluye al autor; '' no coincide con ningún uuid, así que
    // aquí `participantes` no excluye a nadie más.
    const participantes = new Set(await this.repo.participantes(imageId, ''))
    await this.campana(eventId, job.campanaA, participantes, CAMPANA_DE_NOTA)
  }

  private async aEventoYProveedores(
    eventId: string,
    proveedores: Set<string>,
    tipo: string,
    payload: object,
  ): Promise<void> {
    await this.tiempoReal.emitirAEvento(eventId, tipo, payload)
    for (const userId of proveedores) {
      await this.tiempoReal.emitirAUsuario(userId, tipo, payload)
    }
  }

  private async campana(
    eventId: string,
    destinatarios: string[],
    siguenViendo: Set<string>,
    type: string,
  ): Promise<void> {
    for (const userId of destinatarios) {
      if (!siguenViendo.has(userId)) continue
      await this.tiempoReal.emitirAUsuario(userId, NOTIFICACION_CREADA, { eventId, type })
    }
  }
}
