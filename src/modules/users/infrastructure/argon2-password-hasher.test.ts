import { Argon2PasswordHasher } from './argon2-password-hasher'

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher()

  it('produce un hash argon2id verificable', async () => {
    const hash = await hasher.hash('una-contraseña-larga')

    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await hasher.verify(hash, 'una-contraseña-larga')).toBe(true)
  })

  it('rechaza una contraseña incorrecta', async () => {
    const hash = await hasher.hash('correcta')

    expect(await hasher.verify(hash, 'incorrecta')).toBe(false)
  })

  it('genera hashes distintos para la misma contraseña (sal aleatoria)', async () => {
    expect(await hasher.hash('misma')).not.toBe(await hasher.hash('misma'))
  })

  it('NO trunca contraseñas largas, a diferencia de bcrypt', async () => {
    // bcrypt ignora todo lo que pase de 72 bytes: dos frases de contraseña
    // largas con el mismo prefijo serían intercambiables. Argon2 no.
    const base = 'a'.repeat(80)
    const hash = await hasher.hash(`${base}FINAL`)

    expect(await hasher.verify(hash, `${base}OTRO`)).toBe(false)
  })

  it('devuelve false en vez de lanzar ante un hash corrupto', async () => {
    // Un registro corrupto en la tabla no debe convertir el login en un 500:
    // eso distingue al atacante entre "usuario raro" y "usuario normal".
    expect(await hasher.verify('no-es-un-hash', 'lo-que-sea')).toBe(false)
  })
})
