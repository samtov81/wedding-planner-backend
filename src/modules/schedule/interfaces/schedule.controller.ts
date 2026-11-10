import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { type EventAccess, esPlannerDelEvento } from '@/modules/events/domain/event-access'
import { EventAccessOf } from '@/modules/events/interfaces/event-access-of.decorator'
import { EventAccessGuard } from '@/modules/events/interfaces/event-access.guard'
import { RequireEventAccess } from '@/modules/events/interfaces/require-event-access.decorator'
import { type Ubicacion, UnauthorizedError } from '@/shared/domain'
import { idDeRuta } from '@/shared/http/id-de-ruta'
import { validarCon } from '@/shared/http/validar-con'

import { CreateScheduleItemUseCase } from '../application/create-schedule-item.use-case'
import { DeleteScheduleItemUseCase } from '../application/delete-schedule-item.use-case'
import { ListScheduleItemsUseCase } from '../application/list-schedule-items.use-case'
import {
  type ActorDelCronograma,
  UpdateScheduleItemUseCase,
} from '../application/update-schedule-item.use-case'
import { ItemDeCronogramaNoEncontradoError } from '../domain/schedule-errors'
import type { ScheduleItem, ScheduleItemStatus } from '../domain/schedule-item'
import { createScheduleItemSchema, updateScheduleItemSchema } from './schedule.dto'

@UseGuards(JwtAuthGuard, EventAccessGuard)
@Controller('events/:eventId/schedule')
export class ScheduleController {
  constructor(
    private readonly listar: ListScheduleItemsUseCase,
    private readonly crear: CreateScheduleItemUseCase,
    private readonly actualizar: UpdateScheduleItemUseCase,
    private readonly eliminar: DeleteScheduleItemUseCase,
  ) {}

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get()
  async listarItems(
    @Param('eventId') eventId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
  ): Promise<ItemRespuesta[]> {
    return (await this.listar.ejecutar(eventId, esPlannerDelEvento(accesoDe(acceso)))).map(
      aRespuesta,
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post()
  async crearItem(
    @Param('eventId') eventId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<ItemRespuesta> {
    const datos = validarCon(createScheduleItemSchema, body)
    return aRespuesta(
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
      ),
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Patch(':itemId')
  async editarItem(
    @Param('eventId') eventId: string,
    @Param('itemId') itemId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<ItemRespuesta> {
    const id = idDeRuta(itemId, () => new ItemDeCronogramaNoEncontradoError())
    return aRespuesta(
      await this.actualizar.ejecutar(
        eventId,
        id,
        validarCon(updateScheduleItemSchema, body),
        actorDe(acceso, usuario),
      ),
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Delete(':itemId')
  @HttpCode(204)
  async borrarItem(
    @Param('eventId') eventId: string,
    @Param('itemId') itemId: string,
  ): Promise<void> {
    await this.eliminar.ejecutar(
      eventId,
      idDeRuta(itemId, () => new ItemDeCronogramaNoEncontradoError()),
    )
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
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return { userId: usuario.id, esPlanner }
}

interface ItemRespuesta {
  id: string
  eventId: string
  title: string
  description: string | null
  startsAt: string
  endsAt: string | null
  location: Ubicacion | null
  status: ScheduleItemStatus
}

function aRespuesta(item: ScheduleItem): ItemRespuesta {
  return {
    id: item.id,
    eventId: item.eventId,
    title: item.title,
    description: item.description,
    startsAt: item.startsAt.toISOString(),
    endsAt: item.endsAt?.toISOString() ?? null,
    location: item.location,
    status: item.status,
  }
}
