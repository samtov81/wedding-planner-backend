import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { EmailVerificationTokenRepository } from '../application/email-verification-token.repository'
import { EmailVerificationTokenRepositoryFake } from './email-verification-token.repository.fake'
import { PrismaEmailVerificationTokenRepository } from './prisma-email-verification-token.repository'

/**
 * Ruling H1: un doble más permisivo que el adaptador real produce verdes falsos
 * en TODOS los tests que lo usan — aquí, los de `RegisterUseCase` y
 * `VerifyEmailUseCase`, que son los que deciden si una cuenta queda verificada.
 *
 * Cada caso se escribe UNA vez y corre contra los dos. Se comparan las
 * respuestas del PUERTO (`resultado` y `userId`), no las filas: el `id` de cada
 * token lo genera cada implementación a su manera y no forma parte del contrato.
 */
describe('Paridad: EmailVerificationTokenRepositoryFake vs PrismaEmailVerificationTokenRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let real: PrismaEmailVerificationTokenRepository
  let doble: EmailVerificationTokenRepositoryFake
  let userId: string
  let otroUserId: string

  const AHORA = new Date('2026-03-01T10:00:00.000Z')
  const MAÑANA = new Date('2026-03-02T10:00:00.000Z')
  const AYER = new Date('2026-02-28T10:00:00.000Z')

  /**
   * Siembra el MISMO token en los dos. Los hashes se prefijan por implementación
   * porque Postgres los tiene como UNIQUE y las filas del doble se reinician en
   * cada `beforeEach` mientras que las de Postgres se borran a mano: el prefijo
   * mantiene cada caso escribiendo un hash distinto sin coordinar nada.
   */
  async function sembrarEnAmbos(datos: {
    hash: string
    userId?: string
    expiresAt?: Date
  }): Promise<string> {
    const destino = datos.userId ?? userId
    const expiresAt = datos.expiresAt ?? MAÑANA
    await real.crear({ userId: destino, tokenHash: datos.hash, expiresAt })
    await doble.crear({ userId: destino, tokenHash: datos.hash, expiresAt })
    return datos.hash
  }

  /**
   * Los dos sujetos de cada caso. Es una función, no una constante: `real` y
   * `doble` se construyen en `beforeAll`/`beforeEach`, después de que se
   * evalúe el cuerpo del `describe`.
   */
  function implementaciones(): Array<[string, EmailVerificationTokenRepository]> {
    return [
      ['Prisma', real],
      ['doble', doble],
    ]
  }

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    real = new PrismaEmailVerificationTokenRepository(prisma as unknown as PrismaService)

    const mio = await prisma.user.create({
      data: { email: 'mio@verificacion.test', passwordHash: 'x', fullName: 'Mío' },
    })
    const otro = await prisma.user.create({
      data: { email: 'otro@verificacion.test', passwordHash: 'x', fullName: 'Otro' },
    })
    userId = mio.id
    otroUserId = otro.id
  }, 240_000)

  beforeEach(async () => {
    await prisma.emailVerificationToken.deleteMany()
    doble = new EmailVerificationTokenRepositoryFake()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  it('en los dos: un token vigente se consume y devuelve su userId', async () => {
    await sembrarEnAmbos({ hash: 'vigente' })

    for (const [, repo] of implementaciones()) {
      expect(await repo.consumirPorHash('vigente', AHORA)).toEqual({
        resultado: 'CONSUMIDO',
        userId,
      })
    }
  })

  it('en los dos: el segundo consumo dice YA_CONSUMIDO', async () => {
    await sembrarEnAmbos({ hash: 'dos-veces' })

    for (const [, repo] of implementaciones()) {
      await repo.consumirPorHash('dos-veces', AHORA)
      // Un solo uso, pero el segundo clic no es un error: el frontend enseña
      // "ya verificado". Si el doble dijera NO_ENCONTRADO aquí, los tests de
      // `VerifyEmailUseCase` aprobarían un mensaje que producción no da.
      expect((await repo.consumirPorHash('dos-veces', AHORA)).resultado).toBe('YA_CONSUMIDO')
    }
  })

  it('en los dos: un hash que nunca existió no devuelve userId', async () => {
    for (const [, repo] of implementaciones()) {
      expect(await repo.consumirPorHash('nunca-existio', AHORA)).toEqual({
        resultado: 'NO_ENCONTRADO_O_CADUCADO',
      })
    }
  })

  it('en los dos: un token caducado no se consume y se confunde con inexistente', async () => {
    await sembrarEnAmbos({ hash: 'caducado', expiresAt: AYER })

    for (const [nombre, repo] of implementaciones()) {
      expect(await repo.consumirPorHash('caducado', AHORA)).toEqual({
        resultado: 'NO_ENCONTRADO_O_CADUCADO',
      })
      expect(nombre).toBeDefined()
    }
    // Y sigue PENDING: caducar no es consumir.
    expect(
      (await prisma.emailVerificationToken.findUnique({ where: { tokenHash: 'caducado' } }))?.status,
    ).toBe('PENDING')
  })

  it('en los dos: el borde de la caducidad es exclusivo (expiresAt == ahora ya está fuera)', async () => {
    await sembrarEnAmbos({ hash: 'justo-en-el-borde', expiresAt: AHORA })

    for (const [, repo] of implementaciones()) {
      expect((await repo.consumirPorHash('justo-en-el-borde', AHORA)).resultado).toBe(
        'NO_ENCONTRADO_O_CADUCADO',
      )
    }
  })

  it('en los dos: caducarVigentesDe invalida los vigentes de ese usuario y nada más', async () => {
    await sembrarEnAmbos({ hash: 'mio-vigente' })
    await sembrarEnAmbos({ hash: 'ajeno-vigente', userId: otroUserId })

    for (const [, repo] of implementaciones()) {
      await repo.caducarVigentesDe(userId, AHORA)

      expect((await repo.consumirPorHash('mio-vigente', AHORA)).resultado).toBe(
        'NO_ENCONTRADO_O_CADUCADO',
      )
    }
    // El del otro usuario sigue intacto: invalidar los tokens de una cuenta no
    // puede tumbar los de otra. Se consume una vez por implementación.
    for (const [, repo] of implementaciones()) {
      expect((await repo.consumirPorHash('ajeno-vigente', AHORA)).resultado).toBe('CONSUMIDO')
    }
  })

  it('en los dos: caducarVigentesDe no reabre ni reescribe uno ya consumido', async () => {
    await sembrarEnAmbos({ hash: 'ya-usado' })

    for (const [, repo] of implementaciones()) {
      await repo.consumirPorHash('ya-usado', AHORA)
      await repo.caducarVigentesDe(userId, AHORA)

      expect((await repo.consumirPorHash('ya-usado', AHORA)).resultado).toBe('YA_CONSUMIDO')
    }
  })

  it('en los dos: crear el mismo hash dos veces falla (tokenHash es UNIQUE)', async () => {
    await sembrarEnAmbos({ hash: 'repetido' })

    for (const [, repo] of implementaciones()) {
      await expect(
        repo.crear({ userId, tokenHash: 'repetido', expiresAt: MAÑANA }),
      ).rejects.toThrow()
    }
  })

  it('en los dos: dos tokens vigentes del mismo usuario conviven y se consumen por separado', async () => {
    // No hay "un token por usuario": `caducarVigentesDe` existe justo porque la
    // tabla admite varios. Consumir uno no puede tocar al otro.
    await sembrarEnAmbos({ hash: 'primero' })
    await sembrarEnAmbos({ hash: 'segundo' })

    for (const [, repo] of implementaciones()) {
      expect((await repo.consumirPorHash('primero', AHORA)).resultado).toBe('CONSUMIDO')
      expect((await repo.consumirPorHash('segundo', AHORA)).resultado).toBe('CONSUMIDO')
    }
  })
})
