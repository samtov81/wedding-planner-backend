/**
 * Notificaciones PERSISTIDAS para quienes planifican un evento. Definido en la
 * Tarea 14, que es la primera que las necesita (el RSVP público); el adaptador
 * de Prisma llega en la Tarea 15. Hasta entonces se cablea el doble en memoria
 * (ver `NotificationsModule`).
 *
 * Contrato del adaptador real:
 *  - crea UNA `Notification` por cada miembro con membresía ACTIVA del evento
 *    (pareja y planners). Los vendors contratados no son miembros: no reciben.
 *  - escribe con `clienteDe(prisma)` (`database/transaccion.ts`), porque se
 *    llama DENTRO de una `UnidadDeTrabajo`: la notificación se confirma con la
 *    respuesta del invitado o no se confirma. Una notificación persistida es lo
 *    que un cliente desconectado recupera por REST; perderla en silencio
 *    rompería esa promesa.
 *  - `payload` se guarda como JSON: sólo valores serializables.
 */
export interface NotificationPort {
  crearParaMiembros(eventId: string, tipo: string, payload: unknown): Promise<void>
}

export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT')
