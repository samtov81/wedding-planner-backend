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
 *  - `avisarAProveedor` crea (o reaviva) el `event.vendor.booked` de UN
 *    proveedor contratado. Ver su docblock: es el único aviso cuyo destinatario
 *    no es miembro del evento.
 */
export interface NotificationPort {
  crearParaMiembros(eventId: string, tipo: string, payload: unknown): Promise<void>
  crearParaDueno(eventId: string, tipo: string, payload: unknown): Promise<void>

  /**
   * Crea `event.vendor.booked` para `userId` (el usuario de la ficha del
   * proveedor) o reaviva la de ese `eventVendorId`.
   *
   * Correspondencia del aviso: `event.vendor.booked` → permiso `VENDOR` →
   * `/events/:id/dashboard` → sólo el proveedor contratado (el vendor no es
   * miembro: ver `visiblesDe` en el adaptador).
   *
   * Reaviva en vez de duplicar (spec §3): hay UNA fila por contratación. Si la
   * pareja cancela y vuelve a contratar al mismo proveedor, la fila existente
   * vuelve a `readAt = null` y `createdAt = ahora`, así que sube arriba del
   * listado y cuenta como no leída. Alternativa descartada: una fila por cada
   * contratación, que llenaría la campana de avisos repetidos del mismo
   * proveedor. Mismo contrato de transacción que `crearParaMiembros`
   * (`clienteDe(prisma)`).
   */
  avisarAProveedor(eventId: string, userId: string, eventVendorId: string): Promise<void>

  /**
   * Borra el `event.vendor.booked` de esa contratación (y sólo de ella). Lo
   * llama el borrado de la contratación en la MISMA transacción: así volver a
   * añadir y contratar al proveedor (otro `eventVendorId`) deja un solo aviso,
   * no uno huérfano y otro nuevo. Mismo contrato de transacción que
   * `avisarAProveedor` (`clienteDe(prisma)`).
   */
  retirarAvisoProveedor(eventId: string, eventVendorId: string): Promise<void>
}

/**
 * Tipo del aviso al proveedor contratado. Vive junto al puerto y no en
 * `notifications/domain` porque lo importa el módulo `vendors` (que llama a
 * `avisarAProveedor`), y un módulo consume el puerto público de otro, no su
 * `domain/`. Payload: `{ eventVendorId: string }`.
 */
export const TIPO_PROVEEDOR_CONTRATADO = 'event.vendor.booked'

export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT')
