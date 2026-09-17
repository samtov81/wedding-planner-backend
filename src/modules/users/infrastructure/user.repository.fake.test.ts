import { PrismaClient } from '@prisma/client'

import { startPostgres, type PostgresDeTest } from '@/../test/support/containers'

import { UserRepositoryEnMemoria } from './user.repository.fake'
import { PrismaUserRepository } from './prisma-user.repository'
import { EmailYaRegistradoError } from '../domain/user-errors'

describe('Equivalencia: UserRepositoryEnMemoria vs PrismaUserRepository', () => {
  let pg: PostgresDeTest
  let repoReal: PrismaUserRepository
  let repoFake: UserRepositoryEnMemoria
  let prisma: PrismaClient & {
    onModuleInit?: () => Promise<void>
    onModuleDestroy?: () => Promise<void>
  }

  beforeAll(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    async () => {
      pg = await startPostgres()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      const client: any = new PrismaClient({ datasources: { db: { url: pg.url } } })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      client.onModuleInit = async () => {}
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      client.onModuleDestroy = async () => {}
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      prisma = client
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      repoReal = new PrismaUserRepository(client)
      repoFake = new UserRepositoryEnMemoria()
    },
    120_000,
  )

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  afterEach(async () => {
    // Limpiar la BD entre tests
    await prisma.user.deleteMany()
    // Reiniciar el fake
    repoFake = new UserRepositoryEnMemoria()
  })

  it('normaliza email en create + findByEmail con grafía distinta en ambas impls', async () => {
    // Caso: crear con email capitalizado, buscar con minúsculas, debe encontrar

    // Real
    const usuarioReal = await repoReal.create({
      email: '  ANA@Test.COM  ',
      passwordHash: 'hash1',
      fullName: 'Ana',
    })
    const encontradoReal = await repoReal.findByEmail('ana@test.com')

    // Fake
    const usuarioFake = await repoFake.create({
      email: '  ANA@Test.COM  ',
      passwordHash: 'hash1',
      fullName: 'Ana',
    })
    const encontradoFake = await repoFake.findByEmail('ana@test.com')

    // Comparación: mismas propiedades públicas
    expect(encontradoReal).not.toBeNull()
    expect(encontradoFake).not.toBeNull()
    expect(encontradoReal?.email).toBe(encontradoFake?.email)
    expect(encontradoReal?.email).toBe('ana@test.com')
    expect(encontradoReal?.id).toBe(usuarioReal.id)
    expect(encontradoFake?.id).toBe(usuarioFake.id)
  })

  it('rechaza duplicate con email normalizado en distinta grafía en ambas impls', async () => {
    // Caso crítico: crear dos veces con mismo email en distinta grafía debe fallar en ambas
    // (y ANTES de normalizar sería incorrecto)

    // Real: primer create éxito
    await repoReal.create({
      email: 'bob@example.com',
      passwordHash: 'hash1',
      fullName: 'Bob',
    })

    // Fake: primer create éxito
    await repoFake.create({
      email: 'bob@example.com',
      passwordHash: 'hash1',
      fullName: 'Bob',
    })

    // Real: segundo create con distinta grafía debe lanzar
    const realError = repoReal.create({
      email: 'BOB@EXAMPLE.COM',
      passwordHash: 'hash2',
      fullName: 'Bob',
    })

    // Fake: segundo create con distinta grafía debe lanzar
    const fakeError = repoFake.create({
      email: 'BOB@EXAMPLE.COM',
      passwordHash: 'hash2',
      fullName: 'Bob',
    })

    // Ambas lanzan la MISMA clase de error
    await expect(realError).rejects.toThrow(EmailYaRegistradoError)
    await expect(fakeError).rejects.toThrow(EmailYaRegistradoError)
  })

  it('findById devuelve objeto SIN passwordHash en ambas impls', async () => {
    // Caso: la clave passwordHash no debe estar en el resultado de findById

    // Real
    const usuarioReal = await repoReal.create({
      email: 'carol@example.com',
      passwordHash: 'super-secreto',
      fullName: 'Carol',
    })
    const encontradoReal = await repoReal.findById(usuarioReal.id)

    // Fake
    const usuarioFake = await repoFake.create({
      email: 'carol@example.com',
      passwordHash: 'super-secreto',
      fullName: 'Carol',
    })
    const encontradoFake = await repoFake.findById(usuarioFake.id)

    // Comparación sobre claves
    expect(encontradoReal).not.toBeNull()
    expect(encontradoFake).not.toBeNull()
    expect(encontradoReal).not.toHaveProperty('passwordHash')
    expect(encontradoFake).not.toHaveProperty('passwordHash')
    // Ambas tienen las mismas claves públicas
    const clavesReal = Object.keys(encontradoReal!).sort()
    const clavesFake = Object.keys(encontradoFake!).sort()
    expect(clavesReal).toEqual(clavesFake)
  })

  it('create devuelve objeto SIN passwordHash en ambas impls', async () => {
    // Caso: la clave passwordHash no debe estar en el resultado de create

    const usuarioReal = await repoReal.create({
      email: 'david@example.com',
      passwordHash: 'otro-secreto',
      fullName: 'David',
    })

    const usuarioFake = await repoFake.create({
      email: 'david@example.com',
      passwordHash: 'otro-secreto',
      fullName: 'David',
    })

    // Comparación sobre claves y valores
    expect(usuarioReal).not.toHaveProperty('passwordHash')
    expect(usuarioFake).not.toHaveProperty('passwordHash')
    const clavesReal = Object.keys(usuarioReal).sort()
    const clavesFake = Object.keys(usuarioFake).sort()
    expect(clavesReal).toEqual(clavesFake)
  })

  it('findByEmail y findById de inexistentes devuelven null en ambas impls', async () => {
    // Caso: buscar por email/id que no existe debe devolver null

    const uuidInexistente = '00000000-0000-0000-0000-000000000000'

    // Real
    const noExisteReal = await repoReal.findByEmail('inexistente@example.com')
    const noExisteRealId = await repoReal.findById(uuidInexistente)

    // Fake
    const noExisteFake = await repoFake.findByEmail('inexistente@example.com')
    const noExisteFakeId = await repoFake.findById(uuidInexistente)

    // Ambas devuelven null
    expect(noExisteReal).toBeNull()
    expect(noExisteFake).toBeNull()
    expect(noExisteRealId).toBeNull()
    expect(noExisteFakeId).toBeNull()
  })

  it('marcarEmailVerificado actualiza emailVerifiedAt en ambas impls', async () => {
    // Caso: después de marcar verificado, findByEmail debe devolver emailVerifiedAt no null

    // Real
    const usuarioReal = await repoReal.create({
      email: 'eve@example.com',
      passwordHash: 'hash1',
      fullName: 'Eve',
    })
    await repoReal.marcarEmailVerificado(usuarioReal.id)
    const verificadoReal = await repoReal.findByEmail('eve@example.com')

    // Fake
    const usuarioFake = await repoFake.create({
      email: 'eve@example.com',
      passwordHash: 'hash1',
      fullName: 'Eve',
    })
    await repoFake.marcarEmailVerificado(usuarioFake.id)
    const verificadoFake = await repoFake.findByEmail('eve@example.com')

    // Ambas tienen emailVerifiedAt != null
    expect(verificadoReal?.emailVerifiedAt).not.toBeNull()
    expect(verificadoFake?.emailVerifiedAt).not.toBeNull()
  })
})
