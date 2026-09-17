import { UserRepositoryEnMemoria } from './user.repository.fake'
import { EmailYaRegistradoError } from '../domain/user-errors'

describe('UserRepositoryEnMemoria', () => {
  it('normaliza emails igual que el repositorio real', async () => {
    const repo = new UserRepositoryEnMemoria()

    const usuario = await repo.create({
      email: '  USUARIO@TEST.COM  ',
      passwordHash: 'hash123',
      fullName: 'Juan',
    })

    // findByEmail debe encontrarlo normalizando de la misma forma
    const encontrado = await repo.findByEmail('usuario@test.com')
    expect(encontrado).not.toBeNull()
    expect(encontrado?.id).toBe(usuario.id)
  })

  it('rechaza duplicate emails como el repositorio real', async () => {
    const repo = new UserRepositoryEnMemoria()

    await repo.create({
      email: 'ana@example.com',
      passwordHash: 'hash1',
      fullName: 'Ana',
    })

    // Intentar crear con el mismo email (distinta grafía) debe fallar
    await expect(
      repo.create({
        email: 'ANA@EXAMPLE.COM',
        passwordHash: 'hash2',
        fullName: 'Ana',
      })
    ).rejects.toThrow(EmailYaRegistradoError)
  })

  it('filtra passwordHash en findById como el repositorio real', async () => {
    const repo = new UserRepositoryEnMemoria()

    const usuario = await repo.create({
      email: 'test@example.com',
      passwordHash: 'hash-secreto',
      fullName: 'Test',
    })

    const encontrado = await repo.findById(usuario.id)
    expect(encontrado).not.toBeNull()
    expect(encontrado).not.toHaveProperty('passwordHash')
    expect(encontrado?.email).toBe('test@example.com')
  })
})
