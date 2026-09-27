import { Module } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import { OBJECT_STORAGE, type ObjectStorage } from './application/object-storage.port'
import { SubidaDeImagenes } from './application/subida-de-imagenes'
import { R2ObjectStorage } from './infrastructure/r2-object-storage'
import { SinAlmacenamiento } from './infrastructure/sin-almacenamiento'

/**
 * Almacén de fotos. Los ficheros Express de esta carpeta (`storage.routes.ts`,
 * `storage.service.ts`, `ports/`) son del backend anterior y no se usan: este
 * módulo no los toca. `validarReglasCruzadas` garantiza que las R2_* llegan
 * las cuatro o ninguna.
 */
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [ENV],
      useFactory: (env: Env): ObjectStorage =>
        env.R2_ENDPOINT !== undefined &&
        env.R2_ACCESS_KEY_ID !== undefined &&
        env.R2_SECRET_ACCESS_KEY !== undefined &&
        env.R2_BUCKET !== undefined
          ? new R2ObjectStorage({
              endpoint: env.R2_ENDPOINT,
              accessKeyId: env.R2_ACCESS_KEY_ID,
              secretAccessKey: env.R2_SECRET_ACCESS_KEY,
              bucket: env.R2_BUCKET,
            })
          : new SinAlmacenamiento(),
    },
    SubidaDeImagenes,
  ],
  exports: [OBJECT_STORAGE, SubidaDeImagenes],
})
export class StorageModule {}
