/**
 * Nombres de las salas de Socket.IO, en UN sitio: el gateway mete a los
 * sockets en ellas y el adaptador de tiempo real emite a ellas, y una errata
 * entre los dos no falla — emite a una sala vacía.
 *
 * Quién entra en cada una lo decide el gateway con `EventAccessService`:
 *  - `user:<id>`: el propio usuario, al conectar.
 *  - `event:<id>`: quien PLANIFICA el evento (COUPLE, PLANNER y ADMIN). Es la
 *    sala de `RealtimePort.emitirAEvento`. Todo lo que se emite hoy a un
 *    evento son datos de invitados, que por REST sólo leen COUPLE y PLANNER
 *    (`GuestsController`), así que ésta es la audiencia correcta.
 *  - `event:<id>:vendors`: un vendor contratado (BOOKED). Tiene acceso al
 *    evento —`GET /events/:id` le responde— pero no a sus invitados, así que no
 *    puede estar en la sala anterior. Hoy nada se emite aquí (ver
 *    `NotificationsGateway`).
 */
export function salaDeUsuario(userId: string): string {
  return `user:${userId}`
}

export function salaDeEvento(eventId: string): string {
  return `event:${eventId}`
}

export function salaDeVendorsDeEvento(eventId: string): string {
  return `event:${eventId}:vendors`
}

/** Namespace del canal de tiempo real. */
export const NAMESPACE_REALTIME = '/realtime'
