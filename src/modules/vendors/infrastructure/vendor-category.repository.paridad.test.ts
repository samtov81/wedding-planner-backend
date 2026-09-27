import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { VendorCategoryRepository } from '../application/vendor-category.repository'
import { PrismaVendorCategoryRepository } from './prisma-vendor-category.repository'
import { VendorCategoryRepositoryEnMemoria } from './vendor-category.repository.fake'

/**
 * El doble lleva una copia de las categorías que siembra la migración: esta
 * paridad es lo que impide que las dos listas se separen.
 */
describe('Paridad: VendorCategoryRepositoryEnMemoria vs PrismaVendorCategoryRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  const sinId = ({ slug, name }: { slug: string; name: string }) => ({ slug, name })

  it('mismas categorías activas, en el mismo orden, que la migración', async () => {
    const doble: VendorCategoryRepository = new VendorCategoryRepositoryEnMemoria()
    const real: VendorCategoryRepository = new PrismaVendorCategoryRepository(
      prisma as unknown as PrismaService,
    )

    const deLaMigracion = (await real.listarActivas()).map(sinId)
    expect(deLaMigracion.map((c) => c.name)).toEqual([
      'Venue',
      'Catering',
      'Photography',
      'Decor & Floral',
      'Music & Entertainment',
      'Attire & Beauty',
      'Stationery',
      'Media',
    ])
    expect((await doble.listarActivas()).map(sinId)).toEqual(deLaMigracion)
  })

  it('buscarActiva: por slug exacto; desconocida o desactivada es null', async () => {
    const doble = new VendorCategoryRepositoryEnMemoria()
    const real = new PrismaVendorCategoryRepository(prisma as unknown as PrismaService)
    await prisma.vendorCategory.update({ where: { slug: 'media' }, data: { active: false } })
    doble.desactivar('media')

    for (const repo of [doble, real] as VendorCategoryRepository[]) {
      expect(sinId((await repo.buscarActiva('decor-floral'))!)).toEqual({
        slug: 'decor-floral',
        name: 'Decor & Floral',
      })
      expect(await repo.buscarActiva('Decor & Floral')).toBeNull()
      expect(await repo.buscarActiva('media')).toBeNull()
      expect((await repo.listarActivas()).map((c) => c.slug)).not.toContain('media')
    }
    await prisma.vendorCategory.update({ where: { slug: 'media' }, data: { active: true } })
  })
})
