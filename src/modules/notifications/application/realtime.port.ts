/**
 * Emisión en tiempo real. Definido en la Tarea 14; el adaptador es
 * `SocketIoRealtimeAdapter` (Tarea 15, Socket.IO sobre Redis). Las salas a las
 * que emite cada método están en `salas.ts`: `emitirAEvento` llega a quien
 * PLANIFICA el evento (COUPLE, PLANNER, ADMIN), no a los vendors.
 *
 * Quien lo usa es el WORKER de la cola `notifications` (Tarea 15), no la
 * petición HTTP (ruling C23): el RSVP público persiste y ENCOLA el aviso
 * (`JobAvisoRsvp`, jobId `rsvp-<invitationId>-<epochMs>`), y el worker emite. El socket
 * es una optimización de LATENCIA sobre un estado que ya existe, no un canal
 * de verdad.
 */
export interface RealtimePort {
  emitirAEvento(eventId: string, tipo: string, payload: unknown): Promise<void>
  emitirAUsuario(userId: string, tipo: string, payload: unknown): Promise<void>
}

export const REALTIME_PORT = Symbol('REALTIME_PORT')
