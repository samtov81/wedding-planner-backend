import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { PasswordResetTokenRepository } from '../application/password-reset-token.repository'
import { PasswordResetTokenRepositoryFake } from './password-reset-token.repository.fake'
import { PrismaPasswordResetTokenRepository } from './prisma-password-reset-token.repository'

/**
 * Ruling H1: cada caso se escribe una vez y corre contra el doble y contra
 * Postgres. Se comparan las respuestas del PUERTO: el `tokenId` lo genera cada
 * implementación a su manera, así que se compara contra el `id` que devolvió
 * su propio `crear`.
 */
describe('Paridad: PasswordResetTokenRepositoryFake vs PrismaPasswordResetTokenRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let real: PrismaPasswordResetTokenRepository
  let doble: PasswordResetTokenRepositoryFake
  let userId: string
  let otroUserId: string

  const AHORA = new Date('2026-09-22T10:00:00.000Z')
  const LUEGO = new Date('2026-09-22T10:30:00.000Z')
  const ANTES = new Date('2026-09-22T09:30:00.000Z')

  function implementaciones(): Array<[string, PasswordResetTokenRepository]> {
    return [
      ['Prisma', real],
      ['doble', doble],
    ]
  }

  /** Crea el mismo token en los dos y devuelve el id que dio cada uno. */
  async function sembrarEnAmbos(datos: {
    hash: string
    userId?: string
    expiresAt?: Date
  }): Promise<Map<string, string>> {
    const ids = new Map<string, string>()
    for (const [nombre, repo] of implementaciones()) {
      const { id } = await repo.crear({
        userId: datos.userId ?? userId,
        tokenHash: datos.hash,
        expiresAt: datos.expiresAt ?? LUEGO,
      })
      ids.set(nombre, id)
    }
    return ids
  }

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    real = new PrismaPasswordResetTokenRepository(prisma as unknown as PrismaService)
    userId = (
      await prisma.user.create({ data: { email: 'mio@reset.test', passwordHash: 'x', fullName: 'Mío' } })
    ).id
    otroUserId = (
      await prisma.user.create({ data: { email: 'otro@reset.test', passwordHash: 'x', fullName: 'Otro' } })
    ).id
  }, 240_000)

  beforeEach(async () => {
    await prisma.passwordResetToken.deleteMany()
    doble = new PasswordResetTokenRepositoryFake()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  it('en los dos: un token vigente se consume y devuelve userId y tokenId', async () => {
    const ids = await sembrarEnAmbos({ hash: 'vigente' })

    for (const [nombre, repo] of implementaciones()) {
      expect(await repo.consumirPorHash('vigente', AHORA)).toEqual({ userId, tokenId: ids.get(nombre) })
    }
  })

  it('en los dos: el segundo consumo devuelve null (un solo uso)', async () => {
    await sembrarEnAmbos({ hash: 'dos-veces' })

    for (const [, repo] of implementaciones()) {
      await repo.consumirPorHash('dos-veces', AHORA)
      expect(await repo.consumirPorHash('dos-veces', AHORA)).toBeNull()
    }
  })

  it('en los dos: un hash que nunca existió devuelve null', async () => {
    for (const [, repo] of implementaciones()) {
      expect(await repo.consumirPorHash('nunca', AHORA)).toBeNull()
    }
  })

  it('en los dos: un token caducado devuelve null y sigue PENDING', async () => {
    await sembrarEnAmbos({ hash: 'caducado', expiresAt: ANTES })

    for (const [, repo] of implementaciones()) {
      expect(await repo.consumirPorHash('caducado', AHORA)).toBeNull()
    }
    expect(
      (await prisma.passwordResetToken.findUnique({ where: { tokenHash: 'caducado' } }))?.status,
    ).toBe('PENDING')
  })

  it('en los dos: el borde es exclusivo (expiresAt == ahora ya no vale)', async () => {
    await sembrarEnAmbos({ hash: 'borde', expiresAt: AHORA })

    for (const [, repo] of implementaciones()) {
      expect(await repo.consumirPorHash('borde', AHORA)).toBeNull()
    }
  })

  it('en los dos: caducarVigentesDe invalida los de ese usuario y nada más', async () => {
    await sembrarEnAmbos({ hash: 'mio' })
    await sembrarEnAmbos({ hash: 'ajeno', userId: otroUserId })

    for (const [, repo] of implementaciones()) {
      await repo.caducarVigentesDe(userId, AHORA)
      expect(await repo.consumirPorHash('mio', AHORA)).toBeNull()
      expect(await repo.consumirPorHash('ajeno', AHORA)).not.toBeNull()
    }
  })

  it('en los dos: crear el mismo hash dos veces falla (UNIQUE)', async () => {
    await sembrarEnAmbos({ hash: 'repetido' })

    for (const [, repo] of implementaciones()) {
      await expect(repo.crear({ userId, tokenHash: 'repetido', expiresAt: LUEGO })).rejects.toThrow()
    }
  })

  it('en los dos: dos consumos concurrentes del mismo token, sólo uno gana', async () => {
    await sembrarEnAmbos({ hash: 'carrera' })

    for (const [, repo] of implementaciones()) {
      const resultados = await Promise.all([
        repo.consumirPorHash('carrera', AHORA),
        repo.consumirPorHash('carrera', AHORA),
      ])
      expect(resultados.filter((r) => r !== null)).toHaveLength(1)
    }
  })
})
