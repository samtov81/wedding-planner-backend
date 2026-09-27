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
import { DeleteTableUseCase } from '../application/delete-table.use-case'
import { GenerateTablesUseCase } from '../application/generate-tables.use-case'
import { GetSeatingUseCase } from '../application/get-seating.use-case'
import { UpdateTableUseCase } from '../application/update-table.use-case'
import type { AsientoVista, MesaVista } from '../domain/seating'
import { MesaNoEncontradaError } from '../domain/seating-errors'
import {
  actualizarMesaSchema,
  asignarAsientoSchema,
  crearMesaSchema,
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
  ) {}

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get()
  async distribucion(@Param('eventId') eventId: string): Promise<DistribucionRespuesta> {
    return aDistribucion(await this.leer.ejecutar(eventId))
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

function aMesa(m: MesaVista): MesaRespuesta {
  return {
    id: m.id,
    name: m.name,
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
