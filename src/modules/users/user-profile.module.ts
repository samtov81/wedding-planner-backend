import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { StorageModule } from '@/modules/storage/storage.module'

import {
  PrepareAvatarUploadUseCase,
  RemoveAvatarUseCase,
  SetAvatarUseCase,
} from './application/avatar.use-cases'
import { GetMyProfileUseCase } from './application/get-my-profile.use-case'
import { UpdateMyProfileUseCase } from './application/update-my-profile.use-case'
import { ProfileController } from './interfaces/profile.controller'
import { UsersModule } from './users.module'

/**
 * Módulo aparte de `UsersModule` por un ciclo: `AuthModule` importa
 * `UsersModule` (por `USER_REPOSITORY`) y este controlador necesita
 * `JwtAuthGuard` de `AuthModule`. Aquí se importan los dos sin cerrar el
 * círculo.
 */
@Module({
  imports: [AuthModule, UsersModule, StorageModule],
  controllers: [ProfileController],
  providers: [
    GetMyProfileUseCase,
    UpdateMyProfileUseCase,
    PrepareAvatarUploadUseCase,
    SetAvatarUseCase,
    RemoveAvatarUseCase,
  ],
})
export class UserProfileModule {}
