import { Controller, Get, Param } from '@nestjs/common'

import { idDeRuta } from '@/shared/http/id-de-ruta'
import { LIMITADOR_VENDOR_PROFILE, LimiteDeRuta } from '@/shared/http/limitadores'

import {
  type FichaPublicaVista,
  GetPublicVendorProfileUseCase,
} from '../application/get-public-vendor-profile.use-case'
import { FichaNoEncontradaError } from '../domain/vendor-profile-errors'

/**
 * La ficha pública: SIN sesión, para que se pueda compartir el enlace. Va en
 * su propio controlador porque `VendorCatalogController` exige sesión a nivel
 * de clase. Nunca expone el usuario dueño ni su email: sólo lo que el
 * proveedor escribió en su ficha.
 */
@Controller('vendors')
export class PublicVendorProfileController {
  constructor(private readonly leer: GetPublicVendorProfileUseCase) {}

  @LimiteDeRuta(LIMITADOR_VENDOR_PROFILE, { limit: 60, ttl: 60_000 })
  @Get(':vendorId')
  ficha(@Param('vendorId') vendorId: string): Promise<FichaPublicaVista> {
    return this.leer.ejecutar(idDeRuta(vendorId, () => new FichaNoEncontradaError()))
  }
}
