import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { EventAccessGuard } from '@/modules/events/interfaces/event-access.guard'
import { RequireEventAccess } from '@/modules/events/interfaces/require-event-access.decorator'
import { UnauthorizedError } from '@/shared/domain'
import { idDeRuta } from '@/shared/http/id-de-ruta'
import { validarCon } from '@/shared/http/validar-con'

import { AddEventVendorUseCase } from '../application/add-event-vendor.use-case'
import type { EventVendorVista } from '../application/event-vendor.repository'
import { ListEventVendorsUseCase } from '../application/list-event-vendors.use-case'
import { RemoveEventVendorUseCase } from '../application/remove-event-vendor.use-case'
import { UpdateEventVendorUseCase } from '../application/update-event-vendor.use-case'
import { EventVendorNoEncontradoError } from '../domain/vendor-errors'
import { createEventVendorSchema, updateEventVendorSchema } from './event-vendor.dto'

interface EventVendorRespuesta {
  id: string
  eventId: string
  vendorRef: EventVendorVista['vendorRef']
  category: string
  specialty: string | null
  assignedBudget: number | null
  status: EventVendorVista['status']
}

/**
 * Las cuatro rutas exigen `COUPLE` o `PLANNER`: gestionar quién trabaja en el
 * evento es cosa de quien lo planifica, no de un vendor ya contratado ni de
 * cualquiera con acceso de sólo lectura.
 *
 * `@RequireEventAccess` va en CADA método, no en la clase: cuando se escribió,
 * `EventAccessGuard` sólo leía la metadata del HANDLER y el decorador de clase
 * quedaba inerte sin avisar (ver notas de la Tarea 10). Desde el arreglo I-3
 * de la revisión final el guard lee también la clase y falla cerrado sin
 * decorador; la repetición por método se conserva.
 */
@UseGuards(JwtAuthGuard, EventAccessGuard)
@Controller('events/:eventId/vendors')
export class EventVendorsController {
  constructor(
    private readonly agregar: AddEventVendorUseCase,
    private readonly listar: ListEventVendorsUseCase,
    private readonly actualizar: UpdateEventVendorUseCase,
    private readonly eliminar: RemoveEventVendorUseCase,
  ) {}

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get()
  async listarVendors(@Param('eventId') eventId: string): Promise<EventVendorRespuesta[]> {
    const vendors = await this.listar.ejecutar(eventId)
    return vendors.map((v) => this.aRespuesta(v))
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post()
  async agregarVendor(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<EventVendorRespuesta> {
    const yo = this.exigirUsuario(usuario)
    const datos = validarCon(createEventVendorSchema, body)
    const vendor = await this.agregar.ejecutar(eventId, { ...datos, actorUserId: yo.id })
    return this.aRespuesta(vendor)
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Patch(':eventVendorId')
  async actualizarVendor(
    @Param('eventId') eventId: string,
    @Param('eventVendorId') eventVendorId: string,
    @Body() body: unknown,
  ): Promise<EventVendorRespuesta> {
    const id = idDeRuta(eventVendorId, () => new EventVendorNoEncontradoError())
    const datos = validarCon(updateEventVendorSchema, body)
    const vendor = await this.actualizar.ejecutar(eventId, id, datos)
    return this.aRespuesta(vendor)
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Delete(':eventVendorId')
  async eliminarVendor(
    @Param('eventId') eventId: string,
    @Param('eventVendorId') eventVendorId: string,
  ): Promise<{ ok: true }> {
    const id = idDeRuta(eventVendorId, () => new EventVendorNoEncontradoError())
    await this.eliminar.ejecutar(eventId, id)
    return { ok: true }
  }

  private exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
    if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
    return usuario
  }

  private aRespuesta(vendor: EventVendorVista): EventVendorRespuesta {
    return {
      id: vendor.id,
      eventId: vendor.eventId,
      vendorRef: vendor.vendorRef,
      category: vendor.category,
      specialty: vendor.specialty,
      assignedBudget: vendor.assignedBudget,
      status: vendor.status,
    }
  }
}
