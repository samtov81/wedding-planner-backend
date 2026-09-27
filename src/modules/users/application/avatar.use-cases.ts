import { Inject, Injectable } from '@nestjs/common'

import {
  SubidaDeImagenes,
  type SubidaPreparada,
} from '@/modules/storage/application/subida-de-imagenes'

import { prefijoDeAvatar } from '../domain/user'
import { GetMyProfileUseCase } from './get-my-profile.use-case'
import type { PerfilPersonal } from './perfil-personal'
import { USER_REPOSITORY, type UserRepository } from './user.repository'

/** Paso 1: firma el PUT a R2 para una foto nueva. No toca al usuario todavía. */
@Injectable()
export class PrepareAvatarUploadUseCase {
  constructor(private readonly imagenes: SubidaDeImagenes) {}

  ejecutar(
    userId: string,
    archivo: { contentType: string; size: number },
  ): Promise<SubidaPreparada> {
    return this.imagenes.preparar(prefijoDeAvatar(userId), archivo.contentType, archivo.size)
  }
}

/** Paso 2: comprueba lo subido, lo fija como avatar y borra el anterior. */
@Injectable()
export class SetAvatarUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    private readonly imagenes: SubidaDeImagenes,
    private readonly leer: GetMyProfileUseCase,
  ) {}

  async ejecutar(userId: string, key: string): Promise<PerfilPersonal> {
    await this.imagenes.confirmar(prefijoDeAvatar(userId), key)
    const anterior = await this.usuarios.fijarAvatar(userId, key)
    if (anterior !== null && anterior !== key) await this.imagenes.borrar(anterior)
    return await this.leer.ejecutar(userId)
  }
}

@Injectable()
export class RemoveAvatarUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    private readonly imagenes: SubidaDeImagenes,
  ) {}

  async ejecutar(userId: string): Promise<void> {
    const anterior = await this.usuarios.fijarAvatar(userId, null)
    if (anterior !== null) await this.imagenes.borrar(anterior)
  }
}
