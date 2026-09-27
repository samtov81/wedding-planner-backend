import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
import { idDeRuta } from '@/shared/http/id-de-ruta'
import { validarCon } from '@/shared/http/validar-con'

import type { FichaVista } from '../application/ficha-vista'
import {
  GetMyVendorProfileUseCase,
  ReplacePackagesUseCase,
  SaveMyVendorProfileUseCase,
  SetVendorModeUseCase,
} from '../application/my-vendor-profile.use-cases'
import {
  AddPortfolioImageUseCase,
  PreparePortfolioUploadUseCase,
  RemovePortfolioImageUseCase,
  ReorderPortfolioUseCase,
  UpdatePortfolioImageUseCase,
} from '../application/portfolio.use-cases'
import { FotoNoEncontradaError } from '../domain/vendor-profile-errors'
import {
  editarFotoSchema,
  fichaSchema,
  modoProveedorSchema,
  nuevaFotoSchema,
  ordenDeFotosSchema,
  paquetesSchema,
} from './vendor-profile.dto'

/** `JwtAuthGuard` ya lo garantiza; esto sólo estrecha el tipo. */
function yo(usuario: UsuarioAutenticado | undefined): string {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario.id
}

/**
 * La ficha de proveedor del usuario con sesión. Todo usuario puede tener una;
 * el switch (`PUT status`) la publica u oculta. Rutas estáticas
 * (`portfolio/upload-url`, `portfolio/order`) antes de `portfolio/:imageId`.
 */
@UseGuards(JwtAuthGuard)
@Controller('users/me/vendor-profile')
export class MyVendorProfileController {
  constructor(
    private readonly leer: GetMyVendorProfileUseCase,
    private readonly guardar: SaveMyVendorProfileUseCase,
    private readonly modo: SetVendorModeUseCase,
    private readonly paquetes: ReplacePackagesUseCase,
    private readonly prepararFoto: PreparePortfolioUploadUseCase,
    private readonly agregarFoto: AddPortfolioImageUseCase,
    private readonly editarFoto: UpdatePortfolioImageUseCase,
    private readonly borrarFoto: RemovePortfolioImageUseCase,
    private readonly reordenar: ReorderPortfolioUseCase,
  ) {}

  @Get()
  ficha(@CurrentUser() usuario: UsuarioAutenticado | undefined): Promise<FichaVista> {
    return this.leer.ejecutar(yo(usuario))
  }

  @Put()
  guardarFicha(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<FichaVista> {
    return this.guardar.ejecutar(yo(usuario), validarCon(fichaSchema, body))
  }

  @Put('status')
  cambiarModo(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<FichaVista> {
    return this.modo.ejecutar(yo(usuario), validarCon(modoProveedorSchema, body).active)
  }

  @Put('packages')
  reemplazarPaquetes(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<FichaVista> {
    return this.paquetes.ejecutar(yo(usuario), validarCon(paquetesSchema, body).packages)
  }

  @Post('portfolio/upload-url')
  urlDeSubida(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<SubidaPreparada> {
    return this.prepararFoto.ejecutar(yo(usuario), validarCon(archivoDeImagenSchema, body))
  }

  @Put('portfolio/order')
  ordenar(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<FichaVista> {
    return this.reordenar.ejecutar(yo(usuario), validarCon(ordenDeFotosSchema, body).ids)
  }

  @Post('portfolio')
  nuevaFoto(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<FichaVista> {
    return this.agregarFoto.ejecutar(yo(usuario), validarCon(nuevaFotoSchema, body))
  }

  @Patch('portfolio/:imageId')
  describirFoto(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('imageId') imageId: string,
    @Body() body: unknown,
  ): Promise<FichaVista> {
    const id = idDeRuta(imageId, () => new FotoNoEncontradaError())
    return this.editarFoto.ejecutar(yo(usuario), id, validarCon(editarFotoSchema, body))
  }

  @Delete('portfolio/:imageId')
  @HttpCode(204)
  async quitarFoto(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('imageId') imageId: string,
  ): Promise<void> {
    await this.borrarFoto.ejecutar(
      yo(usuario),
      idDeRuta(imageId, () => new FotoNoEncontradaError()),
    )
  }
}
