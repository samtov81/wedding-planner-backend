import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { UnauthorizedError } from '@/shared/domain'
import { validarCon } from '@/shared/http/validar-con'

import { CreateEventUseCase } from '../application/create-event.use-case'
import { EVENT_REPOSITORY, type EventRepository } from '../application/event.repository'
import { InviteMemberUseCase } from '../application/invite-member.use-case'
import { ListEventsUseCase } from '../application/list-events.use-case'
import type { EventAccess } from '../domain/event-access'
import { EventoNoEncontradoError } from '../domain/event-errors'
import { EventAccessOf } from './event-access-of.decorator'
import { EventAccessGuard } from './event-access.guard'
import { createEventSchema, inviteMemberSchema } from './events.dto'
import { RequireEventAccess } from './require-event-access.decorator'

interface EventoRespuesta {
  id: string
  name: string
  weddingDate: string
  timezone: string
  venueLocation: string | null
  ownerId: string
}

@UseGuards(JwtAuthGuard)
@Controller('events')
export class EventsController {
  constructor(
    private readonly crear: CreateEventUseCase,
    private readonly listar: ListEventsUseCase,
    private readonly invitar: InviteMemberUseCase,
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
  ) {}

  @Post()
  async crearEvento(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Body() body: unknown,
  ): Promise<EventoRespuesta> {
    const yo = this.exigirUsuario(usuario)
    const datos = validarCon(createEventSchema, body)
    const evento = await this.crear.ejecutar({ ...datos, ownerId: yo.id })
    return this.aRespuesta(evento)
  }

  @Get()
  async listarEventos(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
  ): Promise<EventoRespuesta[]> {
    const yo = this.exigirUsuario(usuario)
    const eventos = await this.listar.ejecutar(yo.id)
    return eventos.map((evento) => this.aRespuesta(evento))
  }

  /**
   * Leer el evento lo puede hacer cualquiera que esté dentro, incluido un
   * vendor contratado; la lista es explícita porque el guard falla cerrado sin
   * ella. El filtro que importa es el 404 del guard para todos los demás.
   */
  @UseGuards(EventAccessGuard)
  @RequireEventAccess('COUPLE', 'PLANNER', 'VENDOR')
  @Get(':eventId')
  async verEvento(
    @Param('eventId') eventId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
  ): Promise<EventoRespuesta & { access: EventAccess }> {
    const evento = await this.eventos.buscarPorId(eventId)
    // Sólo lo alcanza un ADMIN: a cualquier otro el guard ya le habría dado
    // 404, porque no se puede tener membresía de un evento que no existe.
    if (evento === null) throw new EventoNoEncontradoError()
    // El guard siempre deja el acceso resuelto; si falta, la ruta perdió el
    // guard, y eso es un error de programación, no un acceso `none` inventado.
    if (acceso === undefined) throw new Error('verEvento requires EventAccessGuard')
    return { ...this.aRespuesta(evento), access: acceso }
  }

  /** Invitar toca quién manda en el evento: sólo COUPLE. */
  @UseGuards(EventAccessGuard)
  @RequireEventAccess('COUPLE')
  @Post(':eventId/members')
  async invitarMiembro(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; status: 'INVITED' }> {
    const yo = this.exigirUsuario(usuario)
    const datos = validarCon(inviteMemberSchema, body)
    return await this.invitar.ejecutar({ ...datos, eventId, invitedById: yo.id })
  }

  private exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
    // `@CurrentUser()` es opcional por tipo (ver su docblock): bajo
    // `JwtAuthGuard` nunca falta, pero el tipo no lo sabe y no se fuerza con
    // un `!` que mentiría.
    if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
    return usuario
  }

  private aRespuesta(evento: {
    id: string
    name: string
    weddingDate: Date
    timezone: string
    venueLocation: string | null
    ownerId: string
  }): EventoRespuesta {
    return {
      id: evento.id,
      name: evento.name,
      weddingDate: evento.weddingDate.toISOString(),
      timezone: evento.timezone,
      venueLocation: evento.venueLocation,
      ownerId: evento.ownerId,
    }
  }
}
