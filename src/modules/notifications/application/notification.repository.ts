import type { CursorPage, CursorValue } from '@/shared/domain'

import type { Notificacion, NotificacionConEvento } from '../domain/notification'

export interface OpcionesListado {
  /** Posición del cursor (la última notificación de la página anterior), o `null`. */
  desde: CursorValue | null
  limite: number
  soloNoLeidas: boolean
}

/**
 * Lectura y marcado de las notificaciones de UN usuario en UN evento. Toda
 * operación lleva `eventId` y `userId`: un usuario no ve ni marca las de otro,
 * y el filtro va en la consulta, no en el caso de uso después de leer.
 *
 * La creación NO está aquí: es `NotificationPort.crearParaMiembros`, que
 * implementa el mismo adaptador de Prisma.
 */
export interface NotificationRepository {
  /** Más recientes primero; orden total (`createdAt`, `id`) para que el cursor sea exacto. */
  listar(
    eventId: string,
    userId: string,
    opciones: OpcionesListado,
  ): Promise<CursorPage<Notificacion>>

  /** Contado sobre las filas (`readAt IS NULL`), nunca un contador guardado aparte. */
  contarNoLeidas(eventId: string, userId: string): Promise<number>

  /**
   * Marca como leída. `true` si la notificación existe y es de este usuario en
   * este evento (ya estuviera leída o no: marcar dos veces no cambia su
   * `readAt` original); `false` si no existe o es ajena.
   */
  marcarLeida(
    eventId: string,
    userId: string,
    notificationId: string,
    ahora: Date,
  ): Promise<boolean>

  /**
   * Quiénes reciben las notificaciones del evento: los miembros ACTIVOS
   * (pareja y planners). La misma consulta que usa `crearParaMiembros`, así que
   * el aviso por socket llega a quien tiene la fila persistida.
   */
  destinatarios(eventId: string): Promise<string[]>

  /**
   * Lo mismo que `listar` pero a nivel de usuario: mezcla TODOS sus eventos
   * (campana global), con el mismo orden total y el mismo cursor.
   *
   * "Visible" = es del usuario Y su membresía en ese evento sigue ACTIVE. El
   * filtro va en la consulta, no en el caso de uso (spec §4.1): quien es
   * revocado deja de ver las notificaciones de ese evento, y el contador de
   * `contarNoLeidasDeUsuario` y `marcarTodasLeidas` aplican la MISMA regla para
   * que la lista, la insignia y el "marcar todas" nunca discrepen. No es la
   * decisión de permisos de `EventAccessService` (ese módulo no se toca desde
   * aquí): es el mismo filtro de datos que ya usa `destinatarios()`. Alternativa
   * descartada: listar todas las filas del usuario y filtrar después, que
   * rompe la paginación (páginas cortas) y deja el contador inflado.
   *
   * Comportamiento deliberado: la visibilidad es «ACTIVE HOY». Si un miembro
   * revocado es reinvitado y acepta, sus notificaciones antiguas de ese evento
   * (también las no leídas que `marcarTodasLeidas` no tocó mientras eran
   * invisibles) vuelven a verse. Alternativa descartada en esta ronda: filtrar
   * por la fecha de la última activación de la membresía; la regla del spec es
   * literal y eso exige una columna/fecha nueva. Decisión de producto para más
   * adelante.
   */
  listarDeUsuario(
    userId: string,
    opciones: OpcionesListado,
  ): Promise<CursorPage<NotificacionConEvento>>

  /** No leídas visibles (ver `listarDeUsuario`), contadas sobre las filas. */
  contarNoLeidasDeUsuario(userId: string): Promise<number>

  /**
   * Marca como leídas todas las visibles sin leer y devuelve cuántas marcó.
   * Sólo las visibles (evento con membresía ACTIVE): las de un evento donde ya
   * no es miembro quedan intactas. Idempotente: la segunda llamada devuelve 0 y
   * no mueve ningún `readAt`.
   */
  marcarTodasLeidas(userId: string, ahora: Date): Promise<number>
}

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY')
