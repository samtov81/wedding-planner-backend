import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { encodeCursor, type CursorPage } from '@/shared/domain'

import type {
  BusquedaCatalogo,
  PerfilDeCatalogo,
  VendorCatalogRepository,
} from '../application/vendor-catalog.repository'
import { precioDesde } from '../domain/vendor-profile'

@Injectable()
export class PrismaVendorCatalogRepository implements VendorCatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async buscar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>> {
    const { q, category, cursor, limit } = busqueda
    const where: Prisma.VendorProfileWhereInput = {
      status: 'PUBLISHED',
      ...(category !== null ? { category: { slug: category } } : {}),
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
    // Paquetes y primera foto van en la MISMA consulta (Prisma los resuelve
    // con un IN por relación, no una consulta por ficha): sin N+1.
    const filas = await this.prisma.vendorProfile.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        businessName: true,
        category: { select: { slug: true, name: true } },
        specialty: true,
        currency: true,
        createdAt: true,
        packages: { select: { price: true } },
        // El mismo orden que `CON_HIJOS` en `prisma-vendor-profile.repository.ts`:
        // "la primera foto" del catálogo es la primera de la ficha.
        portfolioImages: {
          select: { storageKey: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          take: 1,
        },
      },
    })
    const items: PerfilDeCatalogo[] = filas.slice(0, limit).map((f) => ({
      id: f.id,
      businessName: f.businessName,
      category: f.category,
      specialty: f.specialty,
      currency: f.currency,
      // Mismo formato que la ficha ("4500.00") y la misma regla de mínimo.
      priceFrom: precioDesde(f.packages.map((p) => ({ price: p.price.toFixed(2) }))),
      imageKey: f.portfolioImages[0]?.storageKey ?? null,
      createdAt: f.createdAt,
    }))
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
