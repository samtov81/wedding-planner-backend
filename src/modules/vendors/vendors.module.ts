import { Module } from '@nestjs/common'

import { AuthModule } from '@/modules/auth/auth.module'
import { PrismaService } from '@/modules/database/prisma.service'
import { EventsModule } from '@/modules/events/events.module'
import { UsersModule } from '@/modules/users/users.module'

import { AddEventVendorUseCase } from './application/add-event-vendor.use-case'
import { EVENT_VENDOR_REPOSITORY } from './application/event-vendor.repository'
import { ListEventVendorsUseCase } from './application/list-event-vendors.use-case'
import { RemoveEventVendorUseCase } from './application/remove-event-vendor.use-case'
import { SearchVendorCatalogUseCase } from './application/search-vendor-catalog.use-case'
import { UpdateEventVendorUseCase } from './application/update-event-vendor.use-case'
import { VENDOR_CATALOG_REPOSITORY } from './application/vendor-catalog.repository'
import { PrismaEventVendorRepository } from './infrastructure/prisma-event-vendor.repository'
import { PrismaVendorCatalogRepository } from './infrastructure/prisma-vendor-catalog.repository'
import { EventVendorsController } from './interfaces/event-vendors.controller'
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
 */
@Module({
  imports: [AuthModule, UsersModule, EventsModule],
  controllers: [EventVendorsController, VendorCatalogController],
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
  ],
})
export class VendorsModule {}
