import { Inject, Injectable } from '@nestjs/common'

import { GetMyProfileUseCase } from './get-my-profile.use-case'
import type { PerfilPersonal } from './perfil-personal'
import { USER_REPOSITORY, type UserRepository } from './user.repository'

/** Hoy sólo el nombre: el email no se cambia desde el perfil. */
@Injectable()
export class UpdateMyProfileUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    private readonly leer: GetMyProfileUseCase,
  ) {}

  async ejecutar(userId: string, cambios: { fullName: string }): Promise<PerfilPersonal> {
    await this.usuarios.actualizarNombre(userId, cambios.fullName)
    return await this.leer.ejecutar(userId)
  }
}
