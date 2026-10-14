import { Controller, Get, UseGuards } from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { UnauthorizedError } from '@/shared/domain'

import type { InvitacionPendiente } from '../application/event.repository'
import { ListMyInvitationsUseCase } from '../application/members.use-cases'

/** Invitaciones pendientes de quien tiene sesión: no cuelgan de ningún evento. */
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MyInvitationsController {
  constructor(private readonly listar: ListMyInvitationsUseCase) {}

  @Get('invitations')
  async misInvitaciones(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
  ): Promise<{ items: InvitacionPendiente[] }> {
    if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
    return { items: await this.listar.ejecutar(usuario.id) }
  }
}
