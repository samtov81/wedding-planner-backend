import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { UnauthorizedError } from '@/shared/domain'
import { validarCon } from '@/shared/http/validar-con'

import {
  AcceptInvitationUseCase,
  DeclineInvitationUseCase,
  ListMembersUseCase,
  RevokeMemberUseCase,
  UpdateMemberUseCase,
  type Miembro,
} from '../application/members.use-cases'
import { MiembroNoEncontradoError, SinInvitacionPendienteError } from '../domain/event-errors'
import { EventAccessGuard } from './event-access.guard'
import { updateMemberSchema } from './members.dto'
import { RequireEventAccess } from './require-event-access.decorator'
import { esUuid } from './uuid'

function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}

/**
 * Un `:membershipId` sin forma de UUID reventaría en Prisma (P2023 → 500). Se
 * responde el mismo 404 que a un id bien formado que no existe, y no un 400 de
 * `validarCon`: un 400 distinguiría "id inventado" de "id ajeno".
 */
function exigirMembershipId(membershipId: string): string {
  if (!esUuid(membershipId)) throw new MiembroNoEncontradoError()
  return membershipId
}

/**
 * Lo mismo para el `:eventId` de aceptar/rechazar, que no pasa por el guard:
 * para quien no tiene invitación, un id mal formado es otro evento sin ella.
 */
function exigirEventIdDeInvitacion(eventId: string): string {
  if (!esUuid(eventId)) throw new SinInvitacionPendienteError()
  return eventId
}

/**
 * Gestión de miembros: sólo el creador (`OWNER`), igual que invitar. Aceptar
 * y rechazar van SIN `EventAccessGuard` a propósito: una membresía INVITED da
 * acceso `none` y el guard respondería 404 justo a quien tiene que entrar. El
 * caso de uso busca la INVITED del usuario autenticado y da el mismo 404 si no
 * la hay, así que no se revela nada que el guard no revelara.
 */
@UseGuards(JwtAuthGuard)
@Controller('events/:eventId')
export class MembersController {
  constructor(
    private readonly listar: ListMembersUseCase,
    private readonly actualizar: UpdateMemberUseCase,
    private readonly revocar: RevokeMemberUseCase,
    private readonly aceptar: AcceptInvitationUseCase,
    private readonly rechazar: DeclineInvitationUseCase,
  ) {}

  @UseGuards(EventAccessGuard)
  @RequireEventAccess('OWNER')
  @Get('members')
  async listarMiembros(@Param('eventId') eventId: string): Promise<{ items: Miembro[] }> {
    return { items: await this.listar.ejecutar(eventId) }
  }

  @UseGuards(EventAccessGuard)
  @RequireEventAccess('OWNER')
  @Patch('members/:membershipId')
  async actualizarMiembro(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ): Promise<Miembro> {
    const yo = exigirUsuario(usuario)
    const id = exigirMembershipId(membershipId)
    const cambios = validarCon(updateMemberSchema, body)
    return await this.actualizar.ejecutar({ eventId, membershipId: id, actorId: yo.id, ...cambios })
  }

  @UseGuards(EventAccessGuard)
  @RequireEventAccess('OWNER')
  @Delete('members/:membershipId')
  @HttpCode(204)
  async revocarMiembro(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Param('membershipId') membershipId: string,
  ): Promise<void> {
    const yo = exigirUsuario(usuario)
    const id = exigirMembershipId(membershipId)
    await this.revocar.ejecutar({ eventId, membershipId: id, actorId: yo.id })
  }

  @Post('invitation/accept')
  @HttpCode(200)
  async aceptarInvitacion(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
  ): Promise<{ eventId: string; status: 'ACTIVE' }> {
    const yo = exigirUsuario(usuario)
    await this.aceptar.ejecutar(exigirEventIdDeInvitacion(eventId), yo.id)
    return { eventId, status: 'ACTIVE' }
  }

  @Post('invitation/decline')
  @HttpCode(204)
  async rechazarInvitacion(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
  ): Promise<void> {
    const yo = exigirUsuario(usuario)
    await this.rechazar.ejecutar(exigirEventIdDeInvitacion(eventId), yo.id)
  }
}
