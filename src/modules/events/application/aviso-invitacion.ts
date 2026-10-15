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
