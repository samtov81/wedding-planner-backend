import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { decodeCursor } from '@/shared/domain'

import { categoriaId } from '../../../../test/support/categorias'
import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { VendorCatalogRepository } from '../application/vendor-catalog.repository'
import { VendorCatalogRepositoryEnMemoria } from './vendor-catalog.repository.fake'
import { categoriaSembrada } from './vendor-category.repository.fake'
import { PrismaVendorCatalogRepository } from './prisma-vendor-catalog.repository'

const BASE = new Date('2026-03-01T00:00:00.000Z')

/**
 * Cada caso corre contra el doble y contra Postgres y compara lo que devuelve
 * el puerto (misma estructura que la paridad de eventos, Tarea 6).
 */
describe('Paridad: VendorCatalogRepositoryEnMemoria vs PrismaVendorCatalogRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let real: PrismaVendorCatalogRepository
  let doble: VendorCatalogRepositoryEnMemoria

  async function sembrar(
    n: number,
    datos: {
      businessName: string
      /** `slug` de la categoría. */
      category: string
      specialty?: string
      status?: 'DRAFT' | 'PUBLISHED' | 'SUSPENDED'
    },
  ) {
    const user = await prisma.user.create({
      data: { email: `v${n}@catalogo.test`, passwordHash: 'x', fullName: `V${n}` },
    })
    const createdAt = new Date(BASE.getTime() + n * 60_000)
    const fila = await prisma.vendorProfile.create({
      data: {
        userId: user.id,
        businessName: datos.businessName,
        categoryId: await categoriaId(prisma, datos.category),
        specialty: datos.specialty ?? null,
        status: datos.status ?? 'PUBLISHED',
        createdAt,
      },
    })
    const { slug, name } = categoriaSembrada(datos.category)
    doble.perfiles.push({
      id: fila.id,
      businessName: datos.businessName,
      category: { slug, name },
      specialty: datos.specialty ?? null,
      status: datos.status ?? 'PUBLISHED',
      createdAt,
    })
  }

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    real = new PrismaVendorCatalogRepository(prisma as unknown as PrismaService)
    doble = new VendorCatalogRepositoryEnMemoria()

    await sembrar(1, { businessName: 'Lumière Catering', category: 'catering' })
    await sembrar(2, {
      businessName: 'Foto Luz',
      category: 'photography',
      specialty: 'Bodas al aire libre',
    })
    await sembrar(3, { businessName: 'Oculto', category: 'catering', status: 'DRAFT' })
    await sembrar(4, { businessName: 'Suspendido', category: 'catering', status: 'SUSPENDED' })
    await sembrar(5, { businessName: 'Banquetes Sol', category: 'catering' })
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  it.each([
    [{ q: null, category: null }, ['Lumière Catering', 'Foto Luz', 'Banquetes Sol']],
    [{ q: 'LUZ', category: null }, ['Foto Luz']],
    [{ q: 'aire libre', category: null }, ['Foto Luz']],
    [{ q: null, category: 'catering' }, ['Lumière Catering', 'Banquetes Sol']],
    [{ q: null, category: 'photography' }, ['Foto Luz']],
    [{ q: null, category: 'no-existe' }, []],
  ] as const)('buscar(%o)', async (filtro, esperado) => {
    for (const repo of [real, doble] as VendorCatalogRepository[]) {
      const pagina = await repo.buscar({ ...filtro, cursor: null, limit: 20 })
      expect(pagina.items.map((p) => p.businessName)).toEqual(esperado)
      expect(pagina.nextCursor).toBeNull()
    }
  })

  it('pagina con cursor sin saltos ni repetidos', async () => {
    for (const repo of [real, doble] as VendorCatalogRepository[]) {
      const p1 = await repo.buscar({ q: null, category: null, cursor: null, limit: 2 })
      expect(p1.items.map((p) => p.businessName)).toEqual(['Lumière Catering', 'Foto Luz'])
      expect(p1.nextCursor).not.toBeNull()
      const p2 = await repo.buscar({
        q: null,
        category: null,
        cursor: decodeCursor(p1.nextCursor ?? ''),
        limit: 2,
      })
      expect(p2.items.map((p) => p.businessName)).toEqual(['Banquetes Sol'])
      expect(p2.nextCursor).toBeNull()
    }
  })
})
