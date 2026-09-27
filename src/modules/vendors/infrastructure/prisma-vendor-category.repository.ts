import { Injectable } from '@nestjs/common'

import { PrismaService } from '@/modules/database/prisma.service'

import type { VendorCategoryRepository } from '../application/vendor-category.repository'
import type { CategoriaDeProveedor } from '../domain/categoria'

const CAMPOS = { id: true, slug: true, name: true } as const

@Injectable()
export class PrismaVendorCategoryRepository implements VendorCategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  listarActivas(): Promise<CategoriaDeProveedor[]> {
    return this.prisma.vendorCategory.findMany({
      where: { active: true },
      orderBy: [{ position: 'asc' }, { slug: 'asc' }],
      select: CAMPOS,
    })
  }

  buscarActiva(slug: string): Promise<CategoriaDeProveedor | null> {
    return this.prisma.vendorCategory.findFirst({ where: { slug, active: true }, select: CAMPOS })
  }
}
