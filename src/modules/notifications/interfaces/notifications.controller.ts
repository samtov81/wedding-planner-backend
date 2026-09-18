import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { EventAccessGuard } from '@/modules/events/interfaces/event-access.guard'
import { RequireEventAccess } from '@/modules/events/interfaces/require-event-access.decorator'
import { decodeCursor, UnauthorizedError } from '@/shared/domain'
import { validarCon } from '@/shared/http/validar-con'

import { ListNotificationsUseCase } from '../application/list-notifications.use-case'
import { MarkReadUseCase } from '../application/mark-read.use-case'
import { NotificacionNoEncontradaError } from '../domain/notification-errors'
import { listarNotificacionesQuerySchema, notificationIdSchema } from './notifications.dto'

interface NotificacionRespuesta {
  id: string
  type: string
  payload: unknown
  readAt: string | null
  createdAt: string
}

interface PaginaRespuesta {
  items: NotificacionRespuesta[]
  nextCursor: string | null
  unreadCount: number
}

/**
 * Las notificaciones PROPIAS del usuario en un evento: lo que un cliente que
 * estuvo desconectado recupera. El socket es latencia; esto es el canal.
 *
 * `COUPLE` y `PLANNER` en CADA método, no en la clase: `EventAccessGuard` lee
 * la metadata del HANDLER y a nivel de clase el decorador sería inerte (ver
 * `EventVendorsController`). Un vendor contratado no es miembro y no recibe
 * notificaciones, así que no tiene nada que leer aquí: 403, como en
 * `/guests`. ADMIN pasa (el guard lo resuelve antes de mirar la lista) y ve
 * las suyas, que son las de un miembro más si lo es, o ninguna.
 *
 * Sin `ThrottlerGuard` propio: el limitador global (`APP_GUARD`) ya cubre estas
 * rutas.
 */
@UseGuards(JwtAuthGuard, EventAccessGuard)
@Controller('events/:eventId/notifications')
export class NotificationsController {
  constructor(
    private readonly listar: ListNotificationsUseCase,
    private readonly marcar: MarkReadUseCase,
  ) {}

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get()
  async listarNotificaciones(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Query() query: unknown,
  ): Promise<PaginaRespuesta> {
    const yo = exigirUsuario(usuario)
    const { cursor, limit, unread } = validarCon(listarNotificacionesQuerySchema, query)

    // Cursor ilegible → `InvalidCursorError` → 400 (como en `/guests`).
    const pagina = await this.listar.ejecutar(eventId, yo.id, {
      desde: cursor === undefined ? null : decodeCursor(cursor),
      limite: limit,
      soloNoLeidas: unread,
    })

    return {
      items: pagina.items.map((n) => ({
        id: n.id,
        type: n.type,
        payload: n.payload,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      nextCursor: pagina.nextCursor,
      unreadCount: pagina.unreadCount,
    }
  }

  /** Idempotente: marcarla dos veces es 204 las dos y no cambia cuándo se leyó. */
  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post(':notificationId/read')
  @HttpCode(204)
  async marcarLeida(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Param('notificationId') notificationId: string,
  ): Promise<void> {
    const yo = exigirUsuario(usuario)
    if (!notificationIdSchema.safeParse(notificationId).success) {
      throw new NotificacionNoEncontradaError()
    }
    await this.marcar.ejecutar(eventId, yo.id, notificationId)
  }
}

function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}
