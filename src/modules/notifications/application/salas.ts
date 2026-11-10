/**
 * Nombres de las salas de Socket.IO, en UN sitio: el gateway mete a los
 * sockets en ellas y el adaptador de tiempo real emite a ellas, y una errata
 * entre los dos no falla — emite a una sala vacía.
 *
 * Quién entra en cada una lo decide el gateway con `EventAccessService`:
 *  - `user:<id>`: el propio usuario, al conectar.
 *  - `event:<id>`: quien PLANIFICA el evento (COUPLE, PLANNER y ADMIN). Es la
 *    sala de `RealtimePort.emitirAEvento`. Ya no lleva sólo datos de invitados
 *    (que por REST sólo leen COUPLE y PLANNER): también el contenido del
 *    moodboard y la presencia de miembros y proveedores (spec 2026-11-09 §7 y
 *    §8). Sigue siendo una sala SÓLO de quien planifica: nada de lo que se
 *    emite aquí puede ir a un proveedor.
 *  - `event:<id>:vendors`: un vendor contratado (BOOKED). Tiene acceso al
 *    evento —`GET /events/:id` le responde— pero no a sus invitados, así que no
 *    puede estar en la sala anterior. Lleva la presencia de los MIEMBROS, y sólo
 *    eso: es común a todos los proveedores del evento, así que ni la presencia
 *    de otro proveedor ni el contenido del moodboard (cada uno ve fotos
 *    distintas, que le llegan por `user:<id>`) pasan por aquí.
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
