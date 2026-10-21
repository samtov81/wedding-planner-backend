import { PrismaClient } from '@prisma/client'

import { startPostgres, type PostgresDeTest } from '../../../test/support/containers'
import type { PrismaService } from './prisma.service'
import { enTransaccion, PrismaUnidadDeTrabajo } from './transaccion'

/**
 * `enTransaccion` existe para que un repositorio que ANTES abría su propia
 * `$transaction` pueda también correr dentro de la unidad de trabajo de un caso
 * de uso. Contra Postgres: es lo único que distingue "se unió a la transacción"
 * de "abrió otra por otra conexión" (el doble de la unidad de trabajo no
 * deshace nada).
 */
describe('enTransaccion', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  it('dentro de una unidad de trabajo, enTransaccion usa la misma transacción: un fallo posterior deshace su escritura', async () => {
    const unidad = new PrismaUnidadDeTrabajo(prisma as unknown as PrismaService)

    await expect(
      unidad.ejecutar(async () => {
        await enTransaccion(prisma, async (tx) => {
          await tx.user.create({
            data: { email: 'dentro@transaccion.test', passwordHash: 'x', fullName: 'Dentro' },
          })
        })
        throw new Error('fallo posterior')
      }),
    ).rejects.toThrow('fallo posterior')

    expect(await prisma.user.findUnique({ where: { email: 'dentro@transaccion.test' } })).toBeNull()
  })

  it('fuera de una unidad de trabajo abre su propia transacción y confirma', async () => {
    await enTransaccion(prisma, async (tx) => {
      await tx.user.create({
        data: { email: 'fuera@transaccion.test', passwordHash: 'x', fullName: 'Fuera' },
      })
    })

    expect(
      await prisma.user.findUnique({ where: { email: 'fuera@transaccion.test' } }),
    ).not.toBeNull()
  })

  it('fuera de una unidad de trabajo, si el trabajo lanza se deshace', async () => {
    await expect(
      enTransaccion(prisma, async (tx) => {
        await tx.user.create({
          data: { email: 'falla@transaccion.test', passwordHash: 'x', fullName: 'Falla' },
        })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await prisma.user.findUnique({ where: { email: 'falla@transaccion.test' } })).toBeNull()
  })
})
