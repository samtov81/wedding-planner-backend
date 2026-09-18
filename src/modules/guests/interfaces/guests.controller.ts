import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'

import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { EventAccessGuard } from '@/modules/events/interfaces/event-access.guard'
import { RequireEventAccess } from '@/modules/events/interfaces/require-event-access.decorator'
import { decodeCursor, type CursorValue } from '@/shared/domain'
import { validarCon } from '@/shared/http/validar-con'

import { CreateGuestUseCase } from '../application/create-guest.use-case'
import { DeleteGuestUseCase } from '../application/delete-guest.use-case'
import { GetGuestUseCase } from '../application/get-guest.use-case'
import type { GuestFilters } from '../application/guest.repository'
import { GuestSummaryUseCase } from '../application/guest-summary.use-case'
import { ListGuestsUseCase } from '../application/list-guests.use-case'
import {
  SendInvitationsUseCase,
  type ResultadoEnvio,
} from '../application/send-invitations.use-case'
import { SendSingleInvitationUseCase } from '../application/send-single-invitation.use-case'
import { UpdateGuestUseCase } from '../application/update-guest.use-case'
import type { Guest, GuestSummary } from '../domain/guest'
import {
  actualizarInvitadoSchema,
  crearInvitadoSchema,
  listarInvitadosQuerySchema,
} from './guest.dto'

interface InvitadoRespuesta {
  id: string
  eventId: string
  name: string
  email: string | null
  group: string
  rsvp: Guest['rsvp']
  dietary: string | null
  createdAt: Date
}

/** Lo que pone `RequestIdMiddleware` en la petición. */
interface PeticionConId {
  requestId?: string
}

interface PaginaRespuesta {
  items: InvitadoRespuesta[]
  nextCursor: string | null
}

/**
 * Las ocho rutas exigen `COUPLE` o `PLANNER`, y eso excluye a `VENDOR` de TODO
 * el controlador: un catering contratado no necesita los datos personales de
 * 150 personas. Si algún día hace falta (restricciones alimentarias), será un
 * endpoint agregado y anonimizado, no acceso a la tabla.
 *
 * DESIGN-GAP: el brief pone `@RequireEventAccess('COUPLE','PLANNER')` UNA vez,
 * a nivel de clase. Ahí es INERTE y en silencio: `EventAccessGuard` lee la
 * metadata con `reflector.get(PERMITIDOS, contexto.getHandler())`, que sólo
 * mira el handler, así que el decorador de clase no llega nunca y el
 * controlador quedaría abierto a cualquiera con acceso al evento —incluido el
 * vendor que el propio brief quiere excluir—. Se repite en CADA método, y el
 * e2e comprueba las seis rutas una por una: un decorador que falta se ve igual
 * que uno que está, y deja la suite en verde.
 */
@UseGuards(JwtAuthGuard, EventAccessGuard)
@Controller('events/:eventId/guests')
export class GuestsController {
  constructor(
    private readonly listar: ListGuestsUseCase,
    private readonly resumir: GuestSummaryUseCase,
    private readonly ver: GetGuestUseCase,
    private readonly crear: CreateGuestUseCase,
    private readonly actualizar: UpdateGuestUseCase,
    private readonly eliminar: DeleteGuestUseCase,
    private readonly enviarInvitaciones: SendInvitationsUseCase,
    private readonly enviarInvitacion: SendSingleInvitationUseCase,
  ) {}

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get()
  async listarInvitados(
    @Param('eventId') eventId: string,
    @Query() query: unknown,
  ): Promise<PaginaRespuesta> {
    const { cursor, limit, ...filtros } = validarCon(listarInvitadosQuerySchema, query)

    // Un cursor ilegible es `InvalidCursorError` → 400, no un 500: el formato
    // es opaco a propósito y el cliente sólo puede haberlo traído de nosotros.
    const posicion: CursorValue | null = cursor === undefined ? null : decodeCursor(cursor)

    const pagina = await this.listar.ejecutar(
      eventId,
      filtros satisfies GuestFilters,
      posicion,
      limit,
    )

    return { items: pagina.items.map((g) => aRespuesta(g)), nextCursor: pagina.nextCursor }
  }

  /**
   * DECLARADA ANTES que `GET /:guestId`: al revés, Express casa `summary` con
   * `:guestId` y el resumen responde 404.
   */
  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get('summary')
  async resumenDeInvitados(@Param('eventId') eventId: string): Promise<GuestSummary> {
    return await this.resumir.ejecutar(eventId)
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post()
  async crearInvitado(
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<InvitadoRespuesta> {
    const datos = validarCon(crearInvitadoSchema, body)

    const invitado = await this.crear.ejecutar(eventId, {
      name: datos.name,
      // Ausente y "sin correo" son lo mismo para el dominio: `null`. Dejarlo
      // en `undefined` haría que la respuesta omitiera el campo y el frontend
      // tuviera que distinguir dos formas de lo mismo.
      email: datos.email ?? null,
      group: datos.group,
      dietary: datos.dietary ?? null,
    })

    return aRespuesta(invitado)
  }

  /**
   * DECLARADA ANTES que `POST /:guestId/invitation` no hace falta —no colisionan—,
   * pero sí ANTES de cualquier futuro `POST /:guestId`: `invitations` casaría
   * con el parámetro y el envío masivo respondería 404.
   *
   * 202 y no 201: la petición ACEPTA el trabajo, no lo termina. Los correos los
   * manda el worker; devolver 201 prometería un recurso que aún no existe.
   */
  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post('invitations')
  @HttpCode(202)
  async enviarTodas(
    @Param('eventId') eventId: string,
    @Req() peticion: PeticionConId,
  ): Promise<ResultadoEnvio> {
    return await this.enviarInvitaciones.ejecutar(eventId, peticion.requestId ?? '')
  }

  /** 202, o 422 `GUEST_HAS_NO_EMAIL` si a ese invitado no hay a dónde escribirle. */
  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post(':guestId/invitation')
  @HttpCode(202)
  async enviarUna(
    @Param('eventId') eventId: string,
    @Param('guestId') guestId: string,
    @Req() peticion: PeticionConId,
  ): Promise<{ guestId: string; invitationId: string }> {
    return await this.enviarInvitacion.ejecutar(eventId, guestId, peticion.requestId ?? '')
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get(':guestId')
  async verInvitado(
    @Param('eventId') eventId: string,
    @Param('guestId') guestId: string,
  ): Promise<InvitadoRespuesta> {
    return aRespuesta(await this.ver.ejecutar(eventId, guestId))
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Patch(':guestId')
  async actualizarInvitado(
    @Param('eventId') eventId: string,
    @Param('guestId') guestId: string,
    @Body() body: unknown,
  ): Promise<InvitadoRespuesta> {
    const cambios = validarCon(actualizarInvitadoSchema, body)

    return aRespuesta(await this.actualizar.ejecutar(eventId, guestId, cambios))
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Delete(':guestId')
  async eliminarInvitado(
    @Param('eventId') eventId: string,
    @Param('guestId') guestId: string,
  ): Promise<{ ok: true }> {
    await this.eliminar.ejecutar(eventId, guestId)
    return { ok: true }
  }
}

function aRespuesta(invitado: Guest): InvitadoRespuesta {
  return {
    id: invitado.id,
    eventId: invitado.eventId,
    name: invitado.name,
    email: invitado.email,
    group: invitado.group,
    rsvp: invitado.rsvp,
    dietary: invitado.dietary,
    createdAt: invitado.createdAt,
  }
}
