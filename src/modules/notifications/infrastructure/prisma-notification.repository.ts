import { Injectable } from '@nestjs/common'
import type { Prisma, Notification as NotificationFila } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe } from '@/modules/database/transaccion'
import { encodeCursor, type CursorPage } from '@/shared/domain'

import type { NotificationPort } from '../application/notification.port'
import type {
  NotificationRepository,
  OpcionesListado,
} from '../application/notification.repository'
import type { Notificacion } from '../domain/notification'

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
