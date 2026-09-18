/**
 * Emisión en tiempo real (Socket.IO sobre Redis en la Tarea 15). Definido en la
 * Tarea 14 con la firma que la Tarea 15 declara, para que ésta sólo aporte el
 * adaptador.
 *
 * Quien lo usa es el WORKER de la cola `notifications` (Tarea 15), no la
 * petición HTTP (ruling C23): el RSVP público persiste y ENCOLA el aviso
 * (`JobAvisoRsvp`, jobId `rsvp-<invitationId>`), y el worker emite. El socket
 * es una optimización de LATENCIA sobre un estado que ya existe, no un canal
 * de verdad.
 */
export interface RealtimePort {
  emitirAEvento(eventId: string, tipo: string, payload: unknown): Promise<void>
  emitirAUsuario(userId: string, tipo: string, payload: unknown): Promise<void>
}

export const REALTIME_PORT = Symbol('REALTIME_PORT')
