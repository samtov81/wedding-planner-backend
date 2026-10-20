import type { Logger } from '@nestjs/common'

import type { QueuePort } from '@/modules/queue/application/queue.port'

/**
 * Contrato del aviso en tiempo real de una invitación a un evento (spec
 * 2026-10-14 §3.1). Vive en `events/application` porque lo PRODUCEN los casos de
 * uso de este módulo; el worker de `notifications` lo importa de aquí, como ya
 * importa los de `guests/application`. `events` no importa nada de
 * `notifications`.
 */
export const TIPO_INVITACION_DE_MIEMBRO = 'invitacion-de-miembro'

/** Nombre del evento de Socket.IO que recibe el invitado en `user:<id>`. */
export const EVENTO_INVITACION_CAMBIADA = 'member-invitation.changed'

export interface JobInvitacionDeMiembro {
  /** El invitado: destinatario del aviso. */
  userId: string
  eventId: string
  cambio: 'nueva' | 'cancelada'
}

/**
 * Único por CAMBIO, no por membresía: invitar, cancelar y volver a invitar a la
 * misma membresía son tres avisos, y con `member-invitation-<id>` BullMQ
 * descartaría los dos últimos por jobId repetido. Con `-`, nunca `:` (ver
 * `EnqueueOptions.jobId`).
 */
export function jobIdDeAvisoInvitacion(membershipId: string, en: Date): string {
  return `member-invitation-${membershipId}-${en.getTime()}`
}

/**
 * Encola el aviso en tiempo real de un cambio de invitación. Es una
 * optimización de latencia (ver `RealtimePort`): cuando se llama, la
 * invitación —o su cancelación— ya está escrita, y si Redis falla el invitado
 * la verá al recargar. Por eso el fallo se registra con un `warn` y NO se
 * propaga, como el aviso de RSVP: propagarlo convertiría en error una
 * operación que sí se hizo.
 *
 * Un solo sitio para invitar (`InviteMemberUseCase`) y cancelar
 * (`RevokeMemberUseCase`): el bloque estaba duplicado en los dos. El
 * `registro` es el `Logger` de quien llama, para que el aviso salga con el
 * contexto de su caso de uso.
 */
export async function encolarAvisoInvitacion(
  cola: QueuePort,
  registro: Logger,
  aviso: JobInvitacionDeMiembro,
  membershipId: string,
): Promise<void> {
  try {
    await cola.enqueue('notifications', TIPO_INVITACION_DE_MIEMBRO, aviso, {
      jobId: jobIdDeAvisoInvitacion(membershipId, new Date()),
    })
  } catch (error) {
    const que = aviso.cambio === 'nueva' ? 'hecha' : 'cancelada'
    registro.warn(
      `Invitación ${que} pero su aviso no se pudo encolar eventId=${aviso.eventId} membershipId=${membershipId}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }
}
