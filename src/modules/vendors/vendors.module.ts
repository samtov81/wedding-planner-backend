import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import { StorageModule } from '@/modules/storage/storage.module'
import { UsersModule } from '@/modules/users/users.module'

import { AddEventVendorUseCase } from './application/add-event-vendor.use-case'
import { GetPublicVendorProfileUseCase } from './application/get-public-vendor-profile.use-case'
import {
  GetMyVendorProfileUseCase,
  ReplacePackagesUseCase,
  SaveMyVendorProfileUseCase,
  SetVendorModeUseCase,
} from './application/my-vendor-profile.use-cases'
import {
  AddPortfolioImageUseCase,
  PreparePortfolioUploadUseCase,
  RemovePortfolioImageUseCase,
  ReorderPortfolioUseCase,
  UpdatePortfolioImageUseCase,
} from './application/portfolio.use-cases'
import { VENDOR_PROFILE_REPOSITORY } from './application/vendor-profile.repository'
import { EVENT_VENDOR_REPOSITORY } from './application/event-vendor.repository'
import { ListEventVendorsUseCase } from './application/list-event-vendors.use-case'
import { RemoveEventVendorUseCase } from './application/remove-event-vendor.use-case'
import { SearchVendorCatalogUseCase } from './application/search-vendor-catalog.use-case'
import { UpdateEventVendorUseCase } from './application/update-event-vendor.use-case'
import { VENDOR_CATALOG_REPOSITORY } from './application/vendor-catalog.repository'
import { PrismaEventVendorRepository } from './infrastructure/prisma-event-vendor.repository'
import { PrismaVendorCatalogRepository } from './infrastructure/prisma-vendor-catalog.repository'
import { PrismaVendorProfileRepository } from './infrastructure/prisma-vendor-profile.repository'
import { EventVendorsController } from './interfaces/event-vendors.controller'
import { MyVendorProfileController } from './interfaces/my-vendor-profile.controller'
import { PublicVendorProfileController } from './interfaces/public-vendor-profile.controller'
import { VendorCatalogController } from './interfaces/vendor-catalog.controller'

/**
 * `EventsModule` se IMPORTA (no se reconstruye nada suyo): `EventAccessGuard`
 * y `RequireEventAccess` son el único punto de autorización sobre eventos, y
 * el controlador los consume de ahí tal cual — ver el `exports` de
 * `EventsModule` para el motivo de por qué el guard ahora sale de él.
 *
 * `UsersModule` se importa por el mismo motivo que en `EventsModule`:
 * `JwtAuthGuard` (de `AuthModule`) inyecta `USER_REPOSITORY` para recargar al
 * usuario, y ese provider sólo lo expone `UsersModule`, no `AuthModule`.
 *
 * `StorageModule` aporta las fotos del portfolio (subida y URLs de lectura).
 */
@Module({
  imports: [AuthModule, UsersModule, EventsModule, StorageModule],
  controllers: [
    EventVendorsController,
    VendorCatalogController,
    PublicVendorProfileController,
    MyVendorProfileController,
  ],
  providers: [
    {
      provide: EVENT_VENDOR_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaEventVendorRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: VENDOR_CATALOG_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaVendorCatalogRepository(prisma),
      inject: [PrismaService],
    },
    AddEventVendorUseCase,
    ListEventVendorsUseCase,
    UpdateEventVendorUseCase,
    RemoveEventVendorUseCase,
    SearchVendorCatalogUseCase,
    {
      provide: VENDOR_PROFILE_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaVendorProfileRepository(prisma),
      inject: [PrismaService],
    },
    GetMyVendorProfileUseCase,
    SaveMyVendorProfileUseCase,
    SetVendorModeUseCase,
    ReplacePackagesUseCase,
    PreparePortfolioUploadUseCase,
    AddPortfolioImageUseCase,
    UpdatePortfolioImageUseCase,
    RemovePortfolioImageUseCase,
    ReorderPortfolioUseCase,
    GetPublicVendorProfileUseCase,
  ],
})
export class VendorsModule {}
