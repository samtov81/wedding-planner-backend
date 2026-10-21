import type { Logger } from '@nestjs/common'

import type { QueuePort } from '@/modules/queue/application/queue.port'

/**
 * Contrato de la notificación que recibe el DUEÑO de un evento cuando alguien
 * acepta o rechaza su invitación de equipo (spec 2026-10-21, campana global de
 * notificaciones, §3). Vive en `events/application` porque lo PRODUCEN los casos
 * de uso de este módulo; el worker de `notifications` lo importa de aquí, como
 * ya importa `aviso-invitacion.ts`.
 *
 * Tipo → permiso → vista (spec §3). Cada tipo de notificación se dirige SÓLO a
 * quien puede abrir la vista a la que lleva; notificar a otro sería un aviso
 * que termina en un 403:
 *
 *   `event.member.responded`  →  `OWNER`  →  `/events/:id/settings`, sección Miembros
 *
 * La vista de destino lee `GET /events/:id/members`, que exige `OWNER`
 * (`Event.ownerId`). Por eso el destinatario es SÓLO el dueño y no «los
 * miembros» del evento, como en `guest.rsvp.updated`, cuya vista (`/guests`)
 * sí la abre cualquier miembro. Una pareja (`COUPLE`) que no es la creadora, o
 * un planner, no recibiría nada que pueda abrir.
 *
 * Por qué la FILA va dentro de la transacción y el AVISO por cola:
 *  - la `Notification` es lo que un cliente desconectado recupera por REST, así
 *    que se confirma con la membresía o no se confirma (si se perdiera, el
 *    dueño nunca sabría que alguien respondió);
 *  - el aviso en tiempo real (`notification.created`) es una optimización de
 *    latencia: se encola DESPUÉS de confirmar y, si Redis falla, el dueño lo ve
 *    al recargar. Encolar dentro de la transacción podría avisar de algo que
 *    luego se deshace.
 *
 * Alternativa descartada: reutilizar la sala del evento (`event:<id>`) para el
 * aviso. Llegaría también a planners, que no pueden abrir la vista; el worker
 * avisa sólo a `user:<ownerId>`.
 */
export const TIPO_RESPUESTA_DE_MIEMBRO = 'event.member.responded'

/** Lo que se persiste en `Notification.payload`. */
export interface PayloadRespuestaDeMiembro {
  /** Quien respondió. */
  userId: string
  /** Su nombre en el momento de responder: la fila no debe depender de un join. */
  fullName: string
  response: 'ACCEPTED' | 'DECLINED'
}

/** Lo que viaja por la cola: sólo lo justo para emitir al dueño. */
export interface JobRespuestaDeMiembro {
  eventId: string
  /** El destinatario del aviso: `Event.ownerId`. */
  ownerId: string
}

/**
 * Único por RESPUESTA, no por membresía: aceptar, que lo revoquen, que lo
 * inviten de nuevo y rechazar son avisos distintos de la misma pareja evento/
 * usuario, y BullMQ descartaría los siguientes por jobId repetido. Con `-`,
 * nunca `:` (ver `EnqueueOptions.jobId`).
 */
export function jobIdDeRespuestaDeMiembro(eventId: string, userId: string, en: Date): string {
  return `member-response-${eventId}-${userId}-${en.getTime()}`
}

/**
 * Encola el aviso en tiempo real de una respuesta. Cuando se llama, la
 * membresía y la `Notification` ya están confirmadas, así que un fallo de Redis
 * se registra con un `warn` y NO se propaga: convertiría en error una operación
 * que sí se hizo (igual que `encolarAvisoInvitacion`).
 */
export async function encolarAvisoRespuesta(
  cola: QueuePort,
  registro: Logger,
  job: JobRespuestaDeMiembro,
  userId: string,
): Promise<void> {
  try {
    await cola.enqueue('notifications', TIPO_RESPUESTA_DE_MIEMBRO, job, {
      jobId: jobIdDeRespuestaDeMiembro(job.eventId, userId, new Date()),
    })
  } catch (error) {
    registro.warn(
      `Respuesta registrada pero su aviso no se pudo encolar eventId=${job.eventId}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }
}
