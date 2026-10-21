import { Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { decodeCursor, UnauthorizedError } from '@/shared/domain'
import { validarCon } from '@/shared/http/validar-con'

import { ListMyNotificationsUseCase } from '../application/list-my-notifications.use-case'
import { MarkAllReadUseCase } from '../application/mark-all-read.use-case'
import { listarNotificacionesQuerySchema } from './notifications.dto'

interface MiNotificacionRespuesta {
  id: string
  type: string
  payload: unknown
  readAt: string | null
  createdAt: string
  event: { id: string; name: string }
}

interface MiPaginaRespuesta {
  items: MiNotificacionRespuesta[]
  nextCursor: string | null
  unreadCount: number
}

/**
 * La campana global: las notificaciones PROPIAS del usuario en todos sus
 * eventos. Sólo `JwtAuthGuard`: no hay `eventId` que autorizar, la pertenencia
 * al evento es un filtro de la consulta (spec §4.1), no un permiso de ruta.
 * Es la misma forma que `MyInvitationsController`.
 *
 * Reutiliza `listarNotificacionesQuerySchema` (cursor, limit, unread) en vez de
 * copiarlo: un único contrato de paginación para las dos rutas. Sin
 * `@LimiteDeRuta`: el limitador global cubre estas rutas.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/notifications')
export class MyNotificationsController {
  constructor(
    private readonly listar: ListMyNotificationsUseCase,
    private readonly marcarTodas: MarkAllReadUseCase,
  ) {}

  @Get()
  async listarMias(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Query() query: unknown,
  ): Promise<MiPaginaRespuesta> {
    const yo = exigirUsuario(usuario)
    const { cursor, limit, unread } = validarCon(listarNotificacionesQuerySchema, query)

    // Cursor ilegible → `InvalidCursorError` → 400 (como en `NotificationsController`).
    const pagina = await this.listar.ejecutar(yo.id, {
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
        event: { id: n.event.id, name: n.event.name },
      })),
      nextCursor: pagina.nextCursor,
      unreadCount: pagina.unreadCount,
    }
  }

  /** Idempotente: repetirla es 204 igual (no hay nada que marcar). */
  @Post('read-all')
  @HttpCode(204)
  async marcarTodasLeidas(@CurrentUser() usuario: UsuarioAutenticado | undefined): Promise<void> {
    await this.marcarTodas.ejecutar(exigirUsuario(usuario).id)
  }
}

function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}
