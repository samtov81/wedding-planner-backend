/**
 * Emisión en tiempo real (Socket.IO sobre Redis en la Tarea 15). Definido en la
 * Tarea 14 con la firma que la Tarea 15 declara, para que ésta sólo aporte el
 * adaptador.
 *
 * El socket es una optimización de LATENCIA sobre un estado que ya existe, no
 * un canal de verdad: se emite DESPUÉS de confirmar la transacción, y un fallo
 * al emitir no deshace ni hace fallar lo que ya se persistió. Quien llama debe
 * tratar el error como un aviso, no como un fallo de su operación.
 */
export interface RealtimePort {
  emitirAEvento(eventId: string, tipo: string, payload: unknown): Promise<void>
  emitirAUsuario(userId: string, tipo: string, payload: unknown): Promise<void>
}

export const REALTIME_PORT = Symbol('REALTIME_PORT')
