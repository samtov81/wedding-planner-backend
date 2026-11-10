import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import type { EventAccess } from '@/modules/events/domain/event-access'
import { EventAccessOf } from '@/modules/events/interfaces/event-access-of.decorator'
import { EventAccessGuard } from '@/modules/events/interfaces/event-access.guard'
import { RequireEventAccess } from '@/modules/events/interfaces/require-event-access.decorator'
import {
  SubidaDeImagenes,
  type SubidaPreparada,
} from '@/modules/storage/application/subida-de-imagenes'
import { ForbiddenError, UnauthorizedError } from '@/shared/domain'
import { idDeRuta } from '@/shared/http/id-de-ruta'
import { LIMITADOR_MOODBOARD_NOTES, LimiteDeRuta } from '@/shared/http/limitadores'
import { validarCon } from '@/shared/http/validar-con'

import type { ImagenDeMoodboard, NotaDeMoodboard } from '../application/moodboard.repository'
import {
  ArchivarImagenUseCase,
  CompartirImagenUseCase,
  CrearImagenUseCase,
  CrearNotaUseCase,
  ListarCompartiblesUseCase,
  ListarImagenesUseCase,
  ListarNotasUseCase,
  ObtenerImagenUseCase,
  PrepararSubidaUseCase,
  ResumenUseCase,
} from '../application/moodboard.use-cases'
import { ImagenNoEncontradaError } from '../domain/moodboard-errors'
import {
  archivarSchema,
  compartirSchema,
  crearImagenSchema,
  listarImagenesQuerySchema,
  notaSchema,
  uploadUrlSchema,
} from './moodboard.dto'
import {
  compartibleJson,
  imagenJson,
  type ImageJson,
  notaJson,
  type NoteJson,
  resumenJson,
  type ShareableVendorJson,
  type SummaryJson,
  visorDe,
} from './moodboard.json'

/** Acciones de quien planifica ("M" en el contrato). */
const MIEMBRO = ['COUPLE', 'PLANNER'] as const
/** Acciones del tablero que también hace un proveedor ("T" en el contrato). */
const TODOS = ['COUPLE', 'PLANNER', 'VENDOR'] as const

const imagenDeRuta = (imageId: string): string =>
  idDeRuta(imageId, () => new ImagenNoEncontradaError())

/**
 * Moodboard del evento (spec 2026-11-09, contrato de la Task 7). La
 * autorización GRUESA (quién entra en cada ruta) es `EventAccessGuard` con
 * `RequireEventAccess`; la FINA (qué fotos ve un proveedor) la decide el
 * repositorio con el `Visor` que `visorDe` traduce del acceso. Los errores de
 * dominio salen tal cual por el `DomainExceptionFilter` global: aquí no se
 * captura ni se re-mapea ninguno.
 *
 * Las URLs de las fotos y de los avatares se firman AQUÍ, al responder
 * (`SubidaDeImagenes.firmarLectura`, la misma vía que el avatar en `users`):
 * son de vida corta y no pertenecen a la entidad. Alternativa descartada:
 * firmarlas en los casos de uso, que obligaría a cada uno a conocer el almacén
 * aunque sólo lo necesite la respuesta HTTP.
 */
@UseGuards(JwtAuthGuard, EventAccessGuard)
@Controller('events/:eventId/moodboard')
export class MoodboardController {
  constructor(
    private readonly prepararSubida: PrepararSubidaUseCase,
    private readonly crearImagen: CrearImagenUseCase,
    private readonly listarImagenes: ListarImagenesUseCase,
    private readonly obtenerImagen: ObtenerImagenUseCase,
    private readonly archivarImagen: ArchivarImagenUseCase,
    private readonly compartirImagen: CompartirImagenUseCase,
    private readonly listarCompartibles: ListarCompartiblesUseCase,
    private readonly listarNotas: ListarNotasUseCase,
    private readonly crearNota: CrearNotaUseCase,
    private readonly resumen: ResumenUseCase,
    private readonly imagenes: SubidaDeImagenes,
  ) {}

  @RequireEventAccess(...MIEMBRO)
  @Post('upload-url')
  @HttpCode(201)
  async urlDeSubida(
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<SubidaPreparada> {
    const { contentType, bytes } = validarCon(uploadUrlSchema, body)
    return await this.prepararSubida.ejecutar(eventId, contentType, bytes)
  }

  @RequireEventAccess(...MIEMBRO)
  @Post('images')
  @HttpCode(201)
  async subirImagen(
    @Param('eventId') eventId: string,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<ImageJson> {
    const yo = exigirUsuario(usuario)
    const imagen = await this.crearImagen.ejecutar(
      eventId,
      yo.id,
      validarCon(crearImagenSchema, body),
    )
    return await this.imagenJson(imagen, true)
  }

  /**
   * `?archived=true` es sólo de miembros: un proveedor nunca ve archivadas y
   * el repositorio le devolvería `[]`, pero el contrato pide 403 (con el mismo
   * mensaje que el guard) para que el cliente no confunda "no hay" con "no
   * puedes".
   */
  @RequireEventAccess(...TODOS)
  @Get('images')
  async verImagenes(
    @Param('eventId') eventId: string,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @EventAccessOf() acceso: EventAccess | undefined,
    @Query() query: unknown,
  ): Promise<ImageJson[]> {
    const visor = visorDe(acceso, exigirUsuario(usuario).id)
    const archivadas = validarCon(listarImagenesQuerySchema, query).archived === 'true'
    if (archivadas && visor.tipo === 'proveedor') {
      throw new ForbiddenError('No tienes permiso para esta operación en este evento')
    }
    const lista = await this.listarImagenes.ejecutar(eventId, visor, archivadas)
    return await Promise.all(lista.map((i) => this.imagenJson(i, visor.tipo === 'miembro')))
  }

  @RequireEventAccess(...TODOS)
  @Get('images/:imageId')
  async verImagen(
    @Param('eventId') eventId: string,
    @Param('imageId') imageId: string,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @EventAccessOf() acceso: EventAccess | undefined,
  ): Promise<ImageJson> {
    const visor = visorDe(acceso, exigirUsuario(usuario).id)
    const imagen = await this.obtenerImagen.ejecutar(eventId, imagenDeRuta(imageId), visor)
    return await this.imagenJson(imagen, visor.tipo === 'miembro')
  }

  @RequireEventAccess(...MIEMBRO)
  @Patch('images/:imageId')
  async archivar(
    @Param('eventId') eventId: string,
    @Param('imageId') imageId: string,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<ImageJson> {
    const yo = exigirUsuario(usuario)
    const id = imagenDeRuta(imageId)
    const { archived } = validarCon(archivarSchema, body)
    return await this.imagenJson(
      await this.archivarImagen.ejecutar(eventId, id, yo.id, archived),
      true,
    )
  }

  @RequireEventAccess(...MIEMBRO)
  @Put('images/:imageId/shares')
  async compartir(
    @Param('eventId') eventId: string,
    @Param('imageId') imageId: string,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<ImageJson> {
    const yo = exigirUsuario(usuario)
    const id = imagenDeRuta(imageId)
    const { eventVendorIds } = validarCon(compartirSchema, body)
    return await this.imagenJson(
      await this.compartirImagen.ejecutar(eventId, id, yo.id, eventVendorIds),
      true,
    )
  }

  @RequireEventAccess(...MIEMBRO)
  @Get('shareable-vendors')
  async compartibles(@Param('eventId') eventId: string): Promise<ShareableVendorJson[]> {
    return (await this.listarCompartibles.ejecutar(eventId)).map(compartibleJson)
  }

  @RequireEventAccess(...TODOS)
  @Get('images/:imageId/notes')
  async verNotas(
    @Param('eventId') eventId: string,
    @Param('imageId') imageId: string,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @EventAccessOf() acceso: EventAccess | undefined,
  ): Promise<NoteJson[]> {
    const visor = visorDe(acceso, exigirUsuario(usuario).id)
    const notas = await this.listarNotas.ejecutar(eventId, imagenDeRuta(imageId), visor)
    return await Promise.all(notas.map((n) => this.notaJson(n)))
  }

  /**
   * Límite propio `moodboard-notes` (30/min por IP, el mismo DESIGN-GAP que
   * `messages`: el limitador corre antes de `JwtAuthGuard`). Cada nota crea
   * campanas y avisos a varios usuarios: sin él, el global de 120/min dejaría
   * inundar de campanas a todo el tablero desde una cuenta.
   */
  @RequireEventAccess(...TODOS)
  @Post('images/:imageId/notes')
  @HttpCode(201)
  @LimiteDeRuta(LIMITADOR_MOODBOARD_NOTES, { ttl: 60_000, limit: 30 })
  async escribirNota(
    @Param('eventId') eventId: string,
    @Param('imageId') imageId: string,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @EventAccessOf() acceso: EventAccess | undefined,
    @Body() body: unknown,
  ): Promise<NoteJson> {
    const visor = visorDe(acceso, exigirUsuario(usuario).id)
    const id = imagenDeRuta(imageId)
    const { body: texto } = validarCon(notaSchema, body)
    return await this.notaJson(await this.crearNota.ejecutar(eventId, id, visor, texto))
  }

  @RequireEventAccess(...TODOS)
  @Get('summary')
  async verResumen(
    @Param('eventId') eventId: string,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @EventAccessOf() acceso: EventAccess | undefined,
  ): Promise<SummaryJson> {
    const visor = visorDe(acceso, exigirUsuario(usuario).id)
    const resumen = await this.resumen.ejecutar(eventId, visor)
    const avatares = new Map(
      await Promise.all(
        resumen.collaborators.map(
          async (c) => [c.userId, await this.firmarOpcional(c.avatarKey)] as const,
        ),
      ),
    )
    return resumenJson(resumen, avatares)
  }

  private async imagenJson(imagen: ImagenDeMoodboard, esMiembro: boolean): Promise<ImageJson> {
    return imagenJson(imagen, await this.imagenes.firmarLectura(imagen.storageKey), esMiembro)
  }

  private async notaJson(nota: NotaDeMoodboard): Promise<NoteJson> {
    return notaJson(nota, await this.firmarOpcional(nota.author.avatarKey))
  }

  private async firmarOpcional(key: string | null): Promise<string | null> {
    return key === null ? null : await this.imagenes.firmarLectura(key)
  }
}

/**
 * El usuario que `JwtAuthGuard` dejó en la petición, o 401 si falta. Copia
 * local, como en `expenses.controller.ts`: llevarla a `shared/` obligaría a
 * `shared/` a conocer el tipo de `auth`.
 */
function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}
