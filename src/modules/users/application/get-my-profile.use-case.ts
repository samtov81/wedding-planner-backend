import { Inject, Injectable } from '@nestjs/common'

import { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'

import { UsuarioNoEncontradoError } from '../domain/user-errors'
import type { PerfilPersonal } from './perfil-personal'
import { USER_REPOSITORY, type UserRepository } from './user.repository'

@Injectable()
export class GetMyProfileUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    private readonly imagenes: SubidaDeImagenes,
  ) {}

  async ejecutar(userId: string): Promise<PerfilPersonal> {
    const usuario = await this.usuarios.findById(userId)
    if (usuario === null) throw new UsuarioNoEncontradoError()
    const avatarKey = await this.usuarios.leerAvatar(userId)
    return {
      id: usuario.id,
      email: usuario.email,
      fullName: usuario.fullName,
      avatarUrl: avatarKey === null ? null : await this.imagenes.firmarLectura(avatarKey),
    }
  }
}
