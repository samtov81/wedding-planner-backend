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
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common'
import type { Response } from 'express'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { type EventAccess, esPlannerDelEvento } from '@/modules/events/domain/event-access'
import { EventAccessOf } from '@/modules/events/interfaces/event-access-of.decorator'
import { EventAccessGuard } from '@/modules/events/interfaces/event-access.guard'
import { RequireEventAccess } from '@/modules/events/interfaces/require-event-access.decorator'
import { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'
import { UnauthorizedError } from '@/shared/domain'
import { idDeRuta } from '@/shared/http/id-de-ruta'
import { LIMITADOR_SCHEDULE_NOTIFY, LimiteDeRuta } from '@/shared/http/limitadores'
import { validarCon } from '@/shared/http/validar-con'

import { CreateScheduleItemUseCase } from '../application/create-schedule-item.use-case'
import { DeleteScheduleItemUseCase } from '../application/delete-schedule-item.use-case'
import { DescargarPdfUseCase } from '../application/descargar-pdf.use-case'
import { ListScheduleItemsUseCase } from '../application/list-schedule-items.use-case'
import {
  AsignarProveedoresUseCase,
  AvisarProveedoresUseCase,
  ConfirmacionesUseCase,
  CrearNotaUseCase,
  type EstadoDeConfirmaciones,
  ListarAsignablesUseCase,
  ListarNotasUseCase,
} from '../application/participacion.use-cases'
import type { NotaDeItem } from '../application/schedule-item.repository'
import {
  type ActorDelCronograma,
  UpdateScheduleItemUseCase,
} from '../application/update-schedule-item.use-case'
import { ItemDeCronogramaNoEncontradoError } from '../domain/schedule-errors'
import {
  asignarProveedoresSchema,
  confirmarSchema,
  createScheduleItemSchema,
  notaSchema,
  updateScheduleItemSchema,
} from './schedule.dto'
import {
  asignableJson,
  type AssignableVendorJson,
  type ConfirmacionesJson,
  confirmacionesJson,
  itemJson,
  type ItemJson,
  notaJson,
  type NoteJson,
} from './schedule.json'

/** Lo ven y lo usan todos los del evento ("T" en el contrato). */
const TODOS = ['COUPLE', 'PLANNER', 'VENDOR'] as const
/**
 * Quien planifica ("M"). Las rutas "P" del contrato también usan esto y el
 * caso de uso exige `esPlanner`: `@RequireEventAccess('PLANNER')` a secas
 * dejaría fuera al ADMIN (`permisosDe(admin)` es `[]`).
 */
const MIEMBRO = ['COUPLE', 'PLANNER'] as const

const itemDeRuta = (itemId: string): string =>
  idDeRuta(itemId, () => new ItemDeCronogramaNoEncontradoError())

/**
 * Cronograma del evento con sus proveedores (spec 2026-11-10, contrato de la
 * Task 8). La autorización GRUESA es `EventAccessGuard` con
 * `RequireEventAccess`; la FINA ("sólo el planner", "las notas no existen
 * para los demás") la deciden los casos de uso con el `esPlanner` que aquí se
 * traduce del acceso con `esPlannerDelEvento`, la única copia de la regla.
 *
 * Las rutas literales (`assignable-vendors`, `confirmations`,
 * `notify-vendors`, `pdf`) se declaran ANTES de las de `:itemId`: Express
 * casa las rutas en el orden en que Nest las registra, que es el de la clase.
 * Hoy ningún par choca por método y profundidad, pero un `GET /:itemId`
 * futuro se tragaría `GET /pdf` si estuviera debajo.
 *
 * Los avatares se firman AQUÍ, al responder, como en `moodboard.controller.ts`:
 * son URLs de vida corta y no pertenecen a la entidad.
 */
@UseGuards(JwtAuthGuard, EventAccessGuard)
@Controller('events/:eventId/schedule')
export class ScheduleController {
  constructor(
    private readonly listar: ListScheduleItemsUseCase,
    private readonly crear: CreateScheduleItemUseCase,
    private readonly actualizar: UpdateScheduleItemUseCase,
    private readonly eliminar: DeleteScheduleItemUseCase,
    private readonly asignar: AsignarProveedoresUseCase,
    private readonly asignables: ListarAsignablesUseCase,
    private readonly listarNotas: ListarNotasUseCase,
    private readonly crearNota: CrearNotaUseCase,
    private readonly confirmaciones: ConfirmacionesUseCase,
    private readonly avisar: AvisarProveedoresUseCase,
    private readonly pdf: DescargarPdfUseCase,
    private readonly imagenes: SubidaDeImagenes,
  ) {}

  /** Todos ven los proveedores de cada ítem; `noteCount`, sólo el planner. */
  @RequireEventAccess(...TODOS)
  @Get()
  async listarItems(
    @Param('eventId') eventId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
  ): Promise<ItemJson[]> {
    return (await this.listar.ejecutar(eventId, esPlannerDelEvento(accesoDe(acceso)))).map(itemJson)
  }

  /** `eventVendorIds` es sólo del planner: el caso de uso responde 403 a los demás. */
  @RequireEventAccess(...MIEMBRO)
  @Post()
  async crearItem(
    @Param('eventId') eventId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<ItemJson> {
    const datos = validarCon(createScheduleItemSchema, body)
    return itemJson(
      await this.crear.ejecutar(
        eventId,
        {
          title: datos.title,
          description: datos.description ?? null,
          startsAt: datos.startsAt,
          endsAt: datos.endsAt ?? null,
          location: datos.location ?? null,
          status: datos.status,
        },
        actorDe(acceso, usuario),
        datos.eventVendorIds,
      ),
    )
  }

  @RequireEventAccess(...MIEMBRO)
  @Get('assignable-vendors')
  async verAsignables(
    @Param('eventId') eventId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
  ): Promise<AssignableVendorJson[]> {
    return (await this.asignables.ejecutar(eventId, actorDe(acceso, usuario))).map(asignableJson)
  }

  /**
   * "Vendors Ready X of Y" para todos; `mine` (lo que le falta confirmar)
   * sólo si quien mira es un proveedor. Lo decide el acceso que resolvió el
   * guard, no el rol del usuario en otra parte.
   */
  @RequireEventAccess(...TODOS)
  @Get('confirmations')
  async verConfirmaciones(
    @Param('eventId') eventId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
  ): Promise<ConfirmacionesJson> {
    const proveedor = accesoDe(acceso).kind === 'vendor' ? exigirUsuario(usuario).id : null
    return await this.confirmacionesJson(await this.confirmaciones.estado(eventId, proveedor))
  }

  /**
   * Confirma lo que el proveedor tenía delante (spec 2026-11-10 §4): el
   * `userId` sale de la sesión, nunca del cuerpo. 200 y no 201: no crea un
   * recurso, cambia el estado de asignaciones que ya existían.
   */
  @RequireEventAccess('VENDOR')
  @Post('confirmations')
  @HttpCode(200)
  async confirmar(
    @Param('eventId') eventId: string,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<ConfirmacionesJson> {
    const yo = exigirUsuario(usuario)
    const { items } = validarCon(confirmarSchema, body)
    return await this.confirmacionesJson(await this.confirmaciones.confirmar(eventId, yo.id, items))
  }

  /**
   * Límite propio `schedule-notify` (5 por hora por IP, spec 2026-11-10 §6):
   * cada pulsación crea una campana por proveedor pendiente. Se cuenta aunque
   * la respuesta sea 403 (el limitador corre antes que el caso de uso), igual
   * que `moodboard-notes`.
   */
  @RequireEventAccess(...MIEMBRO)
  @Post('notify-vendors')
  @HttpCode(200)
  @LimiteDeRuta(LIMITADOR_SCHEDULE_NOTIFY, { ttl: 3_600_000, limit: 5 })
  async avisarProveedores(
    @Param('eventId') eventId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
  ): Promise<{ notified: number }> {
    return await this.avisar.ejecutar(eventId, actorDe(acceso, usuario))
  }

  /**
   * El PDF lleva notas SÓLO si quien lo pide es planner: el caso de uso ni
   * las lee en otro caso. `passthrough` para fijar las cabeceras y seguir
   * devolviendo el cuerpo por Nest (y sus filtros de excepción).
   */
  @RequireEventAccess(...TODOS)
  @Get('pdf')
  async descargarPdf(
    @Param('eventId') eventId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.pdf.ejecutar(
      eventId,
      esPlannerDelEvento(accesoDe(acceso)),
    )
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    })
    return new StreamableFile(buffer)
  }

  @RequireEventAccess(...MIEMBRO)
  @Patch(':itemId')
  async editarItem(
    @Param('eventId') eventId: string,
    @Param('itemId') itemId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<ItemJson> {
    const id = itemDeRuta(itemId)
    return itemJson(
      await this.actualizar.ejecutar(
        eventId,
        id,
        validarCon(updateScheduleItemSchema, body),
        actorDe(acceso, usuario),
      ),
    )
  }

  @RequireEventAccess(...MIEMBRO)
  @Delete(':itemId')
  @HttpCode(204)
  async borrarItem(
    @Param('eventId') eventId: string,
    @Param('itemId') itemId: string,
  ): Promise<void> {
    await this.eliminar.ejecutar(eventId, itemDeRuta(itemId))
  }

  @RequireEventAccess(...MIEMBRO)
  @Put(':itemId/vendors')
  async asignarProveedores(
    @Param('eventId') eventId: string,
    @Param('itemId') itemId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<ItemJson> {
    const actor = actorDe(acceso, usuario)
    const id = itemDeRuta(itemId)
    const { eventVendorIds } = validarCon(asignarProveedoresSchema, body)
    return itemJson(await this.asignar.ejecutar(eventId, id, actor, eventVendorIds))
  }

  /** Para quien no es planner las notas no existen: 404 (lo decide el caso de uso). */
  @RequireEventAccess(...MIEMBRO)
  @Get(':itemId/notes')
  async verNotas(
    @Param('eventId') eventId: string,
    @Param('itemId') itemId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
  ): Promise<NoteJson[]> {
    const esPlanner = esPlannerDelEvento(accesoDe(acceso))
    const notas = await this.listarNotas.ejecutar(eventId, itemDeRuta(itemId), esPlanner)
    return await Promise.all(notas.map((n) => this.notaJson(n)))
  }

  /**
   * El 404 de quien no es planner se adelanta aquí, ANTES de validar el
   * cuerpo: si no, la pareja que manda un cuerpo roto recibiría 400 y
   * distinguiría esta ruta de una que no existe. No es una segunda copia de
   * la regla —el booleano es el mismo `esPlannerDelEvento` que recibe el caso
   * de uso, que repite el 404 por su cuenta—, sólo el orden de los errores.
   * Alternativa descartada: validar el cuerpo dentro del caso de uso, que
   * metería la forma HTTP (400) en `application/`.
   */
  @RequireEventAccess(...MIEMBRO)
  @Post(':itemId/notes')
  @HttpCode(201)
  async escribirNota(
    @Param('eventId') eventId: string,
    @Param('itemId') itemId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<NoteJson> {
    const actor = actorDe(acceso, usuario)
    const id = itemDeRuta(itemId)
    if (!actor.esPlanner) throw new ItemDeCronogramaNoEncontradoError()
    const { body: texto } = validarCon(notaSchema, body)
    return await this.notaJson(await this.crearNota.ejecutar(eventId, id, actor, texto))
  }

  private async notaJson(nota: NotaDeItem): Promise<NoteJson> {
    return notaJson(nota, await this.firmarOpcional(nota.author.avatarKey))
  }

  private async confirmacionesJson(estado: EstadoDeConfirmaciones): Promise<ConfirmacionesJson> {
    const avatares = new Map(
      await Promise.all(
        estado.vendors.map(
          async (v) => [v.userId, await this.firmarOpcional(v.avatarKey)] as const,
        ),
      ),
    )
    return confirmacionesJson(estado, avatares)
  }

  private async firmarOpcional(key: string | null): Promise<string | null> {
    return key === null ? null : await this.imagenes.firmarLectura(key)
  }
}

/**
 * Sin acceso la ruta perdió su guard: error de programación (500), como en
 * `event-vendors.controller.ts`, nunca un permiso concedido.
 */
function accesoDe(acceso: EventAccess | undefined): EventAccess {
  if (acceso === undefined) throw new Error('ScheduleController requires EventAccessGuard')
  return acceso
}

/** El usuario que `JwtAuthGuard` dejó en la petición, o 401 si falta. */
function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}

/**
 * Traduce el acceso que el guard ya resolvió y el usuario autenticado a lo
 * que el caso de uso necesita (`esPlannerDelEvento`, la única copia de la
 * regla). Sin usuario, 401 como en `moodboard.controller.ts`.
 */
function actorDe(
  acceso: EventAccess | undefined,
  usuario: UsuarioAutenticado | undefined,
): ActorDelCronograma {
  const esPlanner = esPlannerDelEvento(accesoDe(acceso))
  return { userId: exigirUsuario(usuario).id, esPlanner }
}
