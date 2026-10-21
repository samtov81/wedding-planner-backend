/**
 * Notificaciones PERSISTIDAS para quienes planifican un evento. Definido en la
 * Tarea 14, que es la primera que las necesita (el RSVP público); el adaptador
 * es `PrismaNotificationRepository` (Tarea 15). El doble en memoria queda sólo
 * para tests.
 *
 * Contrato del adaptador real:
 *  - crea UNA `Notification` por cada miembro con membresía ACTIVA del evento
 *    (pareja y planners). Los vendors contratados no son miembros: no reciben.
 *  - escribe con `clienteDe(prisma)` (`database/transaccion.ts`), porque se
 *    llama DENTRO de una `UnidadDeTrabajo`: la notificación se confirma con la
 *    respuesta del invitado o no se confirma. Una notificación persistida es lo
 *    que un cliente desconectado recupera por REST; perderla en silencio
 *    rompería esa promesa.
 *  - `crearParaDueno` crea UNA para `Event.ownerId` y nada si el evento no
 *    existe. Es para los avisos cuya vista de destino sólo puede abrir el
 *    dueño (p. ej. `event.member.responded`, que lleva a la sección de
 *    miembros y ésta exige `OWNER`): notificar a quien no puede abrir la vista
 *    sería un aviso que lleva a un 403. Mismo contrato de transacción que
 *    `crearParaMiembros`.
 *  - `payload` se guarda como JSON: sólo valores serializables.
 */
export interface NotificationPort {
  crearParaMiembros(eventId: string, tipo: string, payload: unknown): Promise<void>
  crearParaDueno(eventId: string, tipo: string, payload: unknown): Promise<void>
}

export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT')
