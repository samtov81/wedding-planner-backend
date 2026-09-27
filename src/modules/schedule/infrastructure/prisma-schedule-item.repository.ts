import { Injectable } from '@nestjs/common'
import type { ScheduleItem as Fila } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe } from '@/modules/database/transaccion'
import type { Ubicacion } from '@/shared/domain'

import type {
  CambiosItem,
  DatosNuevoItem,
  ScheduleItemRepository,
} from '../application/schedule-item.repository'
import { ItemDeCronogramaNoEncontradoError } from '../domain/schedule-errors'
import type { ScheduleItem } from '../domain/schedule-item'

interface ColumnasLugar {
  locationName?: string | null
  locationAddress?: string | null
  locationLat?: number | null
  locationLng?: number | null
  locationMapboxId?: string | null
}

function columnasLugar(location: Ubicacion | null | undefined): ColumnasLugar {
  if (location === undefined) return {}
  if (location === null) {
    return {
      locationName: null,
      locationAddress: null,
      locationLat: null,
      locationLng: null,
      locationMapboxId: null,
    }
  }
  return {
    locationName: location.name,
    locationAddress: location.address,
    locationLat: location.lat,
    locationLng: location.lng,
    locationMapboxId: location.mapboxId,
  }
}

@Injectable()
export class PrismaScheduleItemRepository implements ScheduleItemRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listarPorEvento(eventId: string): Promise<ScheduleItem[]> {
    const filas = await this.prisma.scheduleItem.findMany({
      where: { eventId },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    })
    return filas.map(aDominio)
  }

  async buscarPorId(eventId: string, itemId: string): Promise<ScheduleItem | null> {
    const fila = await this.prisma.scheduleItem.findFirst({ where: { id: itemId, eventId } })
    return fila === null ? null : aDominio(fila)
  }

  async crear(datos: DatosNuevoItem): Promise<ScheduleItem> {
    const fila = await clienteDe(this.prisma).scheduleItem.create({
      data: {
        eventId: datos.eventId,
        title: datos.title,
        description: datos.description,
        startsAt: datos.startsAt,
        endsAt: datos.endsAt,
        status: datos.status,
        ...columnasLugar(datos.location),
      },
    })
    return aDominio(fila)
  }

  async actualizar(eventId: string, itemId: string, cambios: CambiosItem): Promise<ScheduleItem> {
    const cliente = clienteDe(this.prisma)
    const { count } = await cliente.scheduleItem.updateMany({
      where: { id: itemId, eventId },
      data: {
        ...(cambios.title !== undefined ? { title: cambios.title } : {}),
        ...(cambios.description !== undefined ? { description: cambios.description } : {}),
        ...(cambios.startsAt !== undefined ? { startsAt: cambios.startsAt } : {}),
        ...(cambios.endsAt !== undefined ? { endsAt: cambios.endsAt } : {}),
        ...(cambios.status !== undefined ? { status: cambios.status } : {}),
        ...columnasLugar(cambios.location),
      },
    })
    if (count === 0) throw new ItemDeCronogramaNoEncontradoError()
    const fila = await cliente.scheduleItem.findFirst({ where: { id: itemId, eventId } })
    if (fila === null) throw new ItemDeCronogramaNoEncontradoError()
    return aDominio(fila)
  }

  async eliminar(eventId: string, itemId: string): Promise<boolean> {
    const { count } = await clienteDe(this.prisma).scheduleItem.deleteMany({
      where: { id: itemId, eventId },
    })
    return count > 0
  }
}

function aDominio(fila: Fila): ScheduleItem {
  const tieneLugar =
    fila.locationAddress !== null && fila.locationLat !== null && fila.locationLng !== null
  return {
    id: fila.id,
    eventId: fila.eventId,
    title: fila.title,
    description: fila.description,
    startsAt: fila.startsAt,
    endsAt: fila.endsAt,
    location: tieneLugar
      ? {
          name: fila.locationName,
          address: fila.locationAddress ?? '',
          lat: Number(fila.locationLat),
          lng: Number(fila.locationLng),
          mapboxId: fila.locationMapboxId,
        }
      : null,
    status: fila.status,
    createdAt: fila.createdAt,
    updatedAt: fila.updatedAt,
  }
}
