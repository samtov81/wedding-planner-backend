import { Injectable } from '@nestjs/common'
import type { Prisma, Notification as NotificationFila } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe } from '@/modules/database/transaccion'
import { encodeCursor, type CursorPage } from '@/shared/domain'

import { TIPO_PROVEEDOR_CONTRATADO, type NotificationPort } from '../application/notification.port'
import type {
  NotificationRepository,
  OpcionesListado,
} from '../application/notification.repository'
import type { Notificacion, NotificacionConEvento } from '../domain/notification'

/**
 * Más recientes primero. (`createdAt`, `id`) es un orden total: con
 * `createdAt` solo, dos notificaciones del mismo RSVP (mismo instante)
 * quedarían en orden arbitrario y el cursor saltaría una.
 */
const ORDEN_ESTABLE = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.NotificationOrderByWithRelationInput[]

/**
 * Sólo `ACTIVE` recibe notificaciones: la misma regla que da acceso al evento
 * (`MEMBRESIA_CON_ACCESO` en `events/domain`). Se repite el literal en vez de
 * importarlo porque un módulo no importa el `domain/` de otro; lo que sujeta la
 * regla aquí es el test de este repositorio con INVITED y REVOKED.
 */
const MIEMBRO_ACTIVO = { status: 'ACTIVE' } satisfies Prisma.EventMembershipWhereInput

/**
 * Las notificaciones de `userId` cuyo evento le sigue dando acceso: membresía
 * ACTIVE (cualquier tipo), o, SÓLO para `event.vendor.booked`, ser el proveedor
 * de una contratación BOOKED de ese evento (el `VendorProfile.userId` es él)
 * con el evento PUBLICADO (`status: 'ACTIVE'`), exactamente como
 * `buscarContratacionReservada` concede acceso a un proveedor: visibilidad y
 * acceso no pueden discrepar. La rama de proveedor va filtrada por tipo: un
 * miembro revocado que luego es contratado no recupera sus avisos de miembro,
 * que llevan a páginas que el proveedor no puede abrir. Un aviso de un evento
 * en borrador aparece cuando éste se publica. Un usuario que es las dos cosas
 * ve cada fila una sola vez: el `OR` está sobre la notificación, no es un join. Una
 * contratación cancelada (o sólo preseleccionada) retira la visibilidad igual
 * que revocar una membresía. Una sola definición para listar, contar y marcar:
 * lista, insignia y "marcar todas" no pueden discrepar.
 *
 * Índice (decisión de la Tarea 1): `EXPLAIN` de `listarDeUsuario` en Postgres 16
 * con 30 000 notificaciones, 51 usuarios y 5 eventos NO hace seq scan sobre
 * `notifications`: usa `notifications_userId_readAt_idx` (Bitmap Index Scan por
 * `userId`) y ordena sólo las filas de ese usuario. Se descarta añadir
 * `@@index([userId, createdAt])`: evitaría el sort, pero un usuario tiene
 * cientos de filas, no millones, y cada índice encarece la escritura de
 * `crearParaMiembros`. Si el volumen por usuario crece, es lo primero a medir.
 */
const visiblesDe = (userId: string): Prisma.NotificationWhereInput => ({
  userId,
  OR: [
    { event: { memberships: { some: { userId, ...MIEMBRO_ACTIVO } } } },
    {
      type: TIPO_PROVEEDOR_CONTRATADO,
      event: {
        status: 'ACTIVE',
        vendors: { some: { status: 'BOOKED', vendorProfile: { userId } } },
      },
    },
  ],
})

/**
 * Adaptador de Prisma de los DOS puertos del módulo: `NotificationPort` (crear,
 * lo usa el RSVP) y `NotificationRepository` (leer y marcar, lo usa el REST).
 */
@Injectable()
export class PrismaNotificationRepository implements NotificationPort, NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `clienteDe(this.prisma)` en las DOS consultas, no `this.prisma`: se llama
   * DENTRO de la unidad de trabajo del RSVP. Con `this.prisma` las filas irían
   * por otra conexión y se confirmarían aunque la respuesta del invitado se
   * deshiciera (hay e2e que lo comprueba). La lectura de miembros va por el
   * mismo cliente para ver lo mismo que la transacción.
   */
  async crearParaMiembros(eventId: string, tipo: string, payload: unknown): Promise<void> {
    const json = comoJson(payload)
    const cliente = clienteDe(this.prisma)

    const miembros = await cliente.eventMembership.findMany({
      where: { eventId, ...MIEMBRO_ACTIVO },
      select: { userId: true },
    })
    if (miembros.length === 0) return

    await cliente.notification.createMany({
      data: miembros.map(({ userId }) => ({ eventId, userId, type: tipo, payload: json })),
    })
  }

  /**
   * Como `crearParaMiembros`, por `clienteDe(this.prisma)`: se llama dentro de
   * la unidad de trabajo que escribe la membresía, y la fila se confirma con
   * ella o no se confirma. Un evento que no existe no crea nada (no es un
   * error: el caso de uso ya validó el evento antes).
   */
  async crearParaDueno(eventId: string, tipo: string, payload: unknown): Promise<void> {
    const json = comoJson(payload)
    const cliente = clienteDe(this.prisma)

    const evento = await cliente.event.findUnique({
      where: { id: eventId },
      select: { ownerId: true },
    })
    if (evento === null) return

    await cliente.notification.create({
      data: { eventId, userId: evento.ownerId, type: tipo, payload: json },
    })
  }

  /**
   * Una fila por contratación: se busca por `payload.eventVendorId` y, si
   * existe, se reaviva (`readAt = null`, `createdAt = ahora`); si no, se crea.
   * `clienteDe(this.prisma)` en las dos escrituras, como el resto del puerto.
   *
   * NO es atómico: `updateMany` + `create` sin índice único podría duplicar la
   * fila si dos llamadas para la misma contratación corrieran a la vez. El
   * llamador debe serializar por contratación: el de `vendors` lo hace con la
   * escritura condicional del estado en la fila `EventVendor` dentro de la misma
   * transacción, que deja ver la transición a una sola transacción y retiene el
   * bloqueo de la fila hasta confirmar.
   */
  async avisarAProveedor(eventId: string, userId: string, eventVendorId: string): Promise<void> {
    const cliente = clienteDe(this.prisma)
    const { count } = await cliente.notification.updateMany({
      where: {
        eventId,
        userId,
        type: TIPO_PROVEEDOR_CONTRATADO,
        payload: { path: ['eventVendorId'], equals: eventVendorId },
      },
      data: { readAt: null, createdAt: new Date() },
    })
    if (count > 0) return

    await cliente.notification.create({
      data: { eventId, userId, type: TIPO_PROVEEDOR_CONTRATADO, payload: { eventVendorId } },
    })
  }

  /**
   * Borra el `event.vendor.booked` de esa contratación (spec §3: una fila por
   * contratación). Se llama dentro de la misma transacción que borra el
   * `EventVendor`, por `clienteDe(this.prisma)`: si se borrara la contratación y
   * quedara el aviso, éste apuntaría a un evento que ya no contrata al proveedor.
   */
  async retirarAvisoProveedor(eventId: string, eventVendorId: string): Promise<void> {
    await clienteDe(this.prisma).notification.deleteMany({
      where: {
        eventId,
        type: TIPO_PROVEEDOR_CONTRATADO,
        payload: { path: ['eventVendorId'], equals: eventVendorId },
      },
    })
  }

  async listar(
    eventId: string,
    userId: string,
    { desde, limite, soloNoLeidas }: OpcionesListado,
  ): Promise<CursorPage<Notificacion>> {
    const filas = await this.prisma.notification.findMany({
      where: {
        eventId,
        userId,
        ...(soloNoLeidas ? { readAt: null } : {}),
        ...(desde !== null
          ? {
              OR: [
                { createdAt: { lt: desde.createdAt } },
                { createdAt: desde.createdAt, id: { lt: desde.id } },
              ],
            }
          : {}),
      },
      orderBy: ORDEN_ESTABLE,
      take: limite + 1,
    })

    const hayMas = filas.length > limite
    const pagina = hayMas ? filas.slice(0, limite) : filas
    const ultimo = pagina.at(-1)
    return {
      items: pagina.map(aNotificacion),
      nextCursor: hayMas && ultimo !== undefined ? encodeCursor(ultimo) : null,
    }
  }

  async contarNoLeidas(eventId: string, userId: string): Promise<number> {
    return await this.prisma.notification.count({ where: { eventId, userId, readAt: null } })
  }

  async marcarLeida(
    eventId: string,
    userId: string,
    notificationId: string,
    ahora: Date,
  ): Promise<boolean> {
    // `readAt: null` en el WHERE: marcar dos veces conserva el primer `readAt`.
    // Si afecta a 0 filas hay que distinguir "ya estaba leída" (éxito) de "no
    // existe o es ajena" (404), con el MISMO filtro de dueño.
    const donde = { id: notificationId, eventId, userId }
    const { count } = await this.prisma.notification.updateMany({
      where: { ...donde, readAt: null },
      data: { readAt: ahora },
    })
    if (count === 1) return true
    return (await this.prisma.notification.count({ where: donde })) === 1
  }

  async listarDeUsuario(
    userId: string,
    { desde, limite, soloNoLeidas }: OpcionesListado,
  ): Promise<CursorPage<NotificacionConEvento>> {
    const filas = await this.prisma.notification.findMany({
      where: {
        ...visiblesDe(userId),
        ...(soloNoLeidas ? { readAt: null } : {}),
        ...(desde !== null
          ? {
              OR: [
                { createdAt: { lt: desde.createdAt } },
                { createdAt: desde.createdAt, id: { lt: desde.id } },
              ],
            }
          : {}),
      },
      include: { event: { select: { id: true, name: true } } },
      orderBy: ORDEN_ESTABLE,
      take: limite + 1,
    })

    const hayMas = filas.length > limite
    const pagina = hayMas ? filas.slice(0, limite) : filas
    const ultimo = pagina.at(-1)
    return {
      items: pagina.map((fila) => ({ ...aNotificacion(fila), event: fila.event })),
      nextCursor: hayMas && ultimo !== undefined ? encodeCursor(ultimo) : null,
    }
  }

  async contarNoLeidasDeUsuario(userId: string): Promise<number> {
    return await this.prisma.notification.count({ where: { ...visiblesDe(userId), readAt: null } })
  }

  async marcarTodasLeidas(userId: string, ahora: Date): Promise<number> {
    // `readAt: null` en el WHERE: las ya leídas conservan su `readAt` original.
    const { count } = await this.prisma.notification.updateMany({
      where: { ...visiblesDe(userId), readAt: null },
      data: { readAt: ahora },
    })
    return count
  }

  async destinatarios(eventId: string): Promise<string[]> {
    const miembros = await this.prisma.eventMembership.findMany({
      where: { eventId, ...MIEMBRO_ACTIVO },
      select: { userId: true },
    })
    return miembros.map((m) => m.userId)
  }
}

/**
 * El payload pasa por `JSON.stringify` antes de llegar a Prisma: así un `Date`
 * se guarda como texto (lo mismo que leerá quien lo recupere) y un valor que no
 * es JSON falla aquí con un mensaje claro — igual que en el doble en memoria.
 */
function comoJson(payload: unknown): Prisma.InputJsonValue {
  const serializado = JSON.stringify(payload) as string | undefined
  if (serializado === undefined) throw new Error('payload no serializable a JSON')
  return JSON.parse(serializado) as Prisma.InputJsonValue
}

function aNotificacion(fila: NotificationFila): Notificacion {
  return {
    id: fila.id,
    type: fila.type,
    payload: fila.payload,
    readAt: fila.readAt,
    createdAt: fila.createdAt,
  }
}
