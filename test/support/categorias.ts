import type { PrismaClient } from '@prisma/client'

/**
 * `id` de una categoría sembrada por la migración, para crear fichas y
 * proveedores de evento directamente con Prisma en los tests.
 */
export async function categoriaId(prisma: PrismaClient, slug = 'photography'): Promise<string> {
  const categoria = await prisma.vendorCategory.findUniqueOrThrow({ where: { slug } })
  return categoria.id
}
