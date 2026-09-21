import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { DatosNuevaSesion } from '../application/session.repository'
import { PrismaSessionRepository } from './prisma-session.repository'

const VUELTAS = 50

describe('PrismaSessionRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let repo: PrismaSessionRepository
  let userId: string

  function datosNueva(familyId: string): DatosNuevaSesion {
    return {
      userId,
      tokenHash: randomUUID(),
      familyId,
      expiresAt: new Date(Date.now() + 86_400_000),
    }
  }

  async function crearSesion(datos: { familyId: string }): Promise<{ id: string }> {
    return await prisma.session.create({ data: datosNueva(datos.familyId), select: { id: true } })
  }

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    repo = new PrismaSessionRepository(prisma as unknown as PrismaService)
    const usuario = await prisma.user.create({
      data: { email: 'sesiones@test.com', passwordHash: 'x', fullName: 'Sesiones' },
    })
    userId = usuario.id
  }, 240_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  it('revocar la familia no deja viva a la hija de una rotación concurrente', async () => {
    // La carrera es probabilística: una sola vuelta casi nunca cae en la
    // ventana (la revocación toma su instantánea después del UPDATE de la
    // rotación y antes de su COMMIT). Cincuenta vueltas, cada una con una
    // familia nueva, la hacen reproducible sin el cerrojo.
    for (let vuelta = 0; vuelta < VUELTAS; vuelta++) {
      const familyId = randomUUID()
      // El padre nace vivo: sólo está para que la familia tenga historia, la
      // carrera se juega entre la hermana y `revocarFamilia`.
      await crearSesion({ familyId })
      const hermana = await crearSesion({ familyId })

      // La rotación de la hermana y la revocación de la familia, a la vez.
      await Promise.all([
        repo.rotar({ sesionARevocar: hermana.id, nueva: datosNueva(familyId) }),
        repo.revocarFamilia(familyId),
      ])

      const vivas = await prisma.session.count({ where: { familyId, revokedAt: null } })
      expect(vivas, `vuelta ${vuelta}`).toBe(0)
    }
  })
})
