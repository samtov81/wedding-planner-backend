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

import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { EventAccessGuard } from '@/modules/events/interfaces/event-access.guard'
import { RequireEventAccess } from '@/modules/events/interfaces/require-event-access.decorator'
import { idDeRuta } from '@/shared/http/id-de-ruta'
import { validarCon } from '@/shared/http/validar-con'

import { AssignSeatUseCase } from '../application/assign-seat.use-case'
import { ClearSeatUseCase } from '../application/clear-seat.use-case'
import { CreateTableUseCase } from '../application/create-table.use-case'
import { CreateObjectUseCase } from '../application/create-object.use-case'
import { DeleteObjectUseCase } from '../application/delete-object.use-case'
import { DeleteTableUseCase } from '../application/delete-table.use-case'
import { GenerateTablesUseCase } from '../application/generate-tables.use-case'
import { GetSeatingUseCase } from '../application/get-seating.use-case'
import { UpdateObjectUseCase } from '../application/update-object.use-case'
import { UpdateTableUseCase } from '../application/update-table.use-case'
import type { AsientoVista, FormaMesa, MesaVista, ObjetoDeSala } from '../domain/seating'
import { MesaNoEncontradaError, ObjetoNoEncontradoError } from '../domain/seating-errors'
import {
  actualizarMesaSchema,
  actualizarObjetoSchema,
  asignarAsientoSchema,
  crearMesaSchema,
  crearObjetoSchema,
  generarMesasSchema,
  indiceDeAsientoDeRuta,
} from './seating.dto'

/** Las rutas estáticas (`tables/generate`) van antes de `tables/:tableId`. */
@UseGuards(JwtAuthGuard, EventAccessGuard)
@Controller('events/:eventId/seating')
export class SeatingController {
  constructor(
    private readonly leer: GetSeatingUseCase,
    private readonly generar: GenerateTablesUseCase,
    private readonly crear: CreateTableUseCase,
    private readonly actualizar: UpdateTableUseCase,
    private readonly eliminar: DeleteTableUseCase,
    private readonly asignar: AssignSeatUseCase,
    private readonly vaciar: ClearSeatUseCase,
    private readonly crearObj: CreateObjectUseCase,
    private readonly actualizarObj: UpdateObjectUseCase,
    private readonly eliminarObj: DeleteObjectUseCase,
  ) {}

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get()
  async distribucion(@Param('eventId') eventId: string): Promise<SalaRespuesta> {
    const { mesas, objetos } = await this.leer.ejecutar(eventId)
    return { ...aDistribucion(mesas), objects: objetos.map(aObjeto) }
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post('tables/generate')
  async generarMesas(
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<DistribucionRespuesta> {
    return aDistribucion(await this.generar.ejecutar(eventId, validarCon(generarMesasSchema, body)))
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post('tables')
  async crearMesa(
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<MesaRespuesta> {
    return aMesa(await this.crear.ejecutar(eventId, validarCon(crearMesaSchema, body)))
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Patch('tables/:tableId')
  async editarMesa(
    @Param('eventId') eventId: string,
    @Param('tableId') tableId: string,
    @Body() body: unknown,
  ): Promise<MesaRespuesta> {
    const id = idDeRuta(tableId, () => new MesaNoEncontradaError())
    return aMesa(
      await this.actualizar.ejecutar(eventId, id, validarCon(actualizarMesaSchema, body)),
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Delete('tables/:tableId')
  @HttpCode(204)
  async borrarMesa(
    @Param('eventId') eventId: string,
    @Param('tableId') tableId: string,
  ): Promise<void> {
    await this.eliminar.ejecutar(
      eventId,
      idDeRuta(tableId, () => new MesaNoEncontradaError()),
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Delete('tables/:tableId/seats/:seatIndex')
  @HttpCode(204)
  async vaciarAsiento(
    @Param('eventId') eventId: string,
    @Param('tableId') tableId: string,
    @Param('seatIndex') seatIndex: string,
  ): Promise<void> {
    const id = idDeRuta(tableId, () => new MesaNoEncontradaError())
    await this.vaciar.ejecutar(eventId, id, validarCon(indiceDeAsientoDeRuta, seatIndex))
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post('objects')
  async crearObjeto(
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<ObjetoRespuesta> {
    return aObjeto(await this.crearObj.ejecutar(eventId, validarCon(crearObjetoSchema, body)))
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Patch('objects/:objectId')
  async editarObjeto(
    @Param('eventId') eventId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ): Promise<ObjetoRespuesta> {
    const id = idDeRuta(objectId, () => new ObjetoNoEncontradoError())
    return aObjeto(
      await this.actualizarObj.ejecutar(eventId, id, validarCon(actualizarObjetoSchema, body)),
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Delete('objects/:objectId')
  @HttpCode(204)
  async borrarObjeto(
    @Param('eventId') eventId: string,
    @Param('objectId') objectId: string,
  ): Promise<void> {
    await this.eliminarObj.ejecutar(
      eventId,
      idDeRuta(objectId, () => new ObjetoNoEncontradoError()),
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Put('assignments')
  async asignarAsiento(
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<DistribucionRespuesta> {
    return aDistribucion(
      await this.asignar.ejecutar(eventId, validarCon(asignarAsientoSchema, body)),
    )
  }
}

interface MesaRespuesta {
  id: string
  name: string
  shape: FormaMesa
  minSeats: number
  maxSeats: number
  seatCount: number
  x: number
  y: number
  seats: AsientoVista[]
}

interface DistribucionRespuesta {
  tables: MesaRespuesta[]
}

interface ObjetoRespuesta {
  id: string
  kind: ObjetoDeSala['kind']
  label: string
  x: number
  y: number
}

/** Solo el GET devuelve también los objetos; generar y asignar responden con las mesas. */
interface SalaRespuesta extends DistribucionRespuesta {
  objects: ObjetoRespuesta[]
}

function aMesa(m: MesaVista): MesaRespuesta {
  return {
    id: m.id,
    name: m.name,
    shape: m.shape,
    minSeats: m.minSeats,
    maxSeats: m.maxSeats,
    seatCount: m.seatCount,
    x: m.x,
    y: m.y,
    seats: m.seats,
  }
}

function aDistribucion(mesas: MesaVista[]): DistribucionRespuesta {
  return { tables: mesas.map(aMesa) }
}

function aObjeto(o: ObjetoDeSala): ObjetoRespuesta {
  return { id: o.id, kind: o.kind, label: o.label, x: o.x, y: o.y }
}
