import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { encodeCursor, type CursorPage } from '@/shared/domain'

import type {
  BusquedaCatalogo,
  PerfilDeCatalogo,
  VendorCatalogRepository,
} from '../application/vendor-catalog.repository'

@Injectable()
export class PrismaVendorCatalogRepository implements VendorCatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async buscar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>> {
    const { q, category, cursor, limit } = busqueda
    const where: Prisma.VendorProfileWhereInput = {
      status: 'PUBLISHED',
      ...(category !== null ? { category: { equals: category, mode: 'insensitive' } } : {}),
      ...(q !== null
        ? {
            OR: [
              { businessName: { contains: q, mode: 'insensitive' } },
              { specialty: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(cursor !== null
        ? {
            AND: [
              {
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                ],
              },
            ],
          }
        : {}),
    }
    // Uno de más para saber si hay página siguiente sin un COUNT aparte.
    const filas = await this.prisma.vendorProfile.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: { id: true, businessName: true, category: true, specialty: true, createdAt: true },
    })
    const items = filas.slice(0, limit)
    const ultimo = items.at(-1)
    return {
      items,
      nextCursor:
        filas.length > limit && ultimo !== undefined
          ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id })
          : null,
    }
  }
}
