import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import type { EventAccess } from '@/modules/events/domain/event-access'
import { accesoAlPresupuesto } from '@/modules/events/domain/presupuesto'
import { EventAccessOf } from '@/modules/events/interfaces/event-access-of.decorator'
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
import type { CategoriaVista } from '../domain/categoria'
import { EventVendorNoEncontradoError } from '../domain/vendor-errors'
import { createEventVendorSchema, updateEventVendorSchema } from './event-vendor.dto'

interface EventVendorRespuesta {
  id: string
  eventId: string
  vendorRef: EventVendorVista['vendorRef']
  category: CategoriaVista
  specialty: string | null
  assignedBudget: string | null
  name: string
  status: EventVendorVista['status']
}

/**
 * Listar exige `COUPLE` o `PLANNER`: ver quién trabaja en el evento es cosa de
 * quien lo planifica, no de un vendor ya contratado. Crear, editar y quitar
 * exigen `OWNER`: gestionar los proveedores es parte de la configuración del
 * evento, que sólo toca quien lo creó.
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
  async listarVendors(
    @Param('eventId') eventId: string,
    @EventAccessOf() acceso: EventAccess | undefined,
  ): Promise<EventVendorRespuesta[]> {
    // El guard siempre deja el acceso resuelto; si falta, la ruta lo perdió.
    if (acceso === undefined) throw new Error('listarVendors requires EventAccessGuard')
    const oculto = accesoAlPresupuesto(acceso) === 'none'
    const vendors = await this.listar.ejecutar(eventId)
    return vendors.map((v) => this.aRespuesta(v, oculto))
  }

  @RequireEventAccess('OWNER')
  @Post()
  async agregarVendor(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<EventVendorRespuesta> {
    const yo = this.exigirUsuario(usuario)
    const datos = validarCon(createEventVendorSchema, body)
    const vendor = await this.agregar.ejecutar(eventId, { ...datos, actorUserId: yo.id })
    return this.aRespuesta(vendor, false)
  }

  @RequireEventAccess('OWNER')
  @Patch(':eventVendorId')
  async actualizarVendor(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Param('eventVendorId') eventVendorId: string,
    @Body() body: unknown,
  ): Promise<EventVendorRespuesta> {
    const yo = this.exigirUsuario(usuario)
    const id = idDeRuta(eventVendorId, () => new EventVendorNoEncontradoError())
    const datos = validarCon(updateEventVendorSchema, body)
    const vendor = await this.actualizar.ejecutar(eventId, id, datos, yo.id)
    return this.aRespuesta(vendor, false)
  }

  @RequireEventAccess('OWNER')
  @Delete(':eventVendorId')
  async eliminarVendor(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Param('eventVendorId') eventVendorId: string,
  ): Promise<{ ok: true }> {
    const yo = this.exigirUsuario(usuario)
    const id = idDeRuta(eventVendorId, () => new EventVendorNoEncontradoError())
    await this.eliminar.ejecutar(eventId, id, yo.id)
    return { ok: true }
  }

  private exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
    if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
    return usuario
  }

  private aRespuesta(vendor: EventVendorVista, oculto: boolean): EventVendorRespuesta {
    return {
      id: vendor.id,
      eventId: vendor.eventId,
      vendorRef: vendor.vendorRef,
      category: vendor.category,
      specialty: vendor.specialty,
      assignedBudget: oculto ? null : vendor.assignedBudget,
      name: vendor.name,
      status: vendor.status,
    }
  }
}
