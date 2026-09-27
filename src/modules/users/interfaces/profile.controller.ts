import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import type { SubidaPreparada } from '@/modules/storage/application/subida-de-imagenes'
import { UnauthorizedError } from '@/shared/domain'
import { archivoDeImagenSchema } from '@/shared/http/esquemas'
import { validarCon } from '@/shared/http/validar-con'

import {
  PrepareAvatarUploadUseCase,
  RemoveAvatarUseCase,
  SetAvatarUseCase,
} from '../application/avatar.use-cases'
import { GetMyProfileUseCase } from '../application/get-my-profile.use-case'
import type { PerfilPersonal } from '../application/perfil-personal'
import { UpdateMyProfileUseCase } from '../application/update-my-profile.use-case'
import { actualizarPerfilSchema, keySubidaSchema } from './profile.dto'

/** `JwtAuthGuard` ya lo garantiza; esto sólo estrecha el tipo. */
function yo(usuario: UsuarioAutenticado | undefined): string {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario.id
}

/** El perfil personal: todo usuario con sesión tiene uno, sólo lo ve él. */
@UseGuards(JwtAuthGuard)
@Controller('users/me')
export class ProfileController {
  constructor(
    private readonly leer: GetMyProfileUseCase,
    private readonly actualizar: UpdateMyProfileUseCase,
    private readonly prepararAvatar: PrepareAvatarUploadUseCase,
    private readonly fijarAvatar: SetAvatarUseCase,
    private readonly quitarAvatar: RemoveAvatarUseCase,
  ) {}

  @Get('profile')
  perfil(@CurrentUser() usuario: UsuarioAutenticado | undefined): Promise<PerfilPersonal> {
    return this.leer.ejecutar(yo(usuario))
  }

  @Patch('profile')
  editarPerfil(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<PerfilPersonal> {
    return this.actualizar.ejecutar(yo(usuario), validarCon(actualizarPerfilSchema, body))
  }

  @Post('avatar/upload-url')
  urlDeSubidaDeAvatar(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<SubidaPreparada> {
    return this.prepararAvatar.ejecutar(yo(usuario), validarCon(archivoDeImagenSchema, body))
  }

  @Put('avatar')
  confirmarAvatar(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<PerfilPersonal> {
    return this.fijarAvatar.ejecutar(yo(usuario), validarCon(keySubidaSchema, body).key)
  }

  @Delete('avatar')
  @HttpCode(204)
  async borrarAvatar(@CurrentUser() usuario: UsuarioAutenticado | undefined): Promise<void> {
    await this.quitarAvatar.ejecutar(yo(usuario))
  }
}
