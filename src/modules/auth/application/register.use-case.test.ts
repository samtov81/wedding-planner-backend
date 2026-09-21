import type { PasswordHasher } from '@/modules/users/application/password-hasher.port'
import { EmailYaRegistradoError } from '@/modules/users/domain/user-errors'
import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { RegisterUseCase } from './register.use-case'

/**
 * Doble mínimo de `PasswordHasher`: modela el hash como `hash:<plano>`. Lo que
 * aquí se prueba es el caso de uso, no Argon2, que tiene su propio test en
 * `argon2-password-hasher.test.ts` y cuesta cientos de milisegundos por llamada.
 */
class HasherDePrueba implements PasswordHasher {
  hash(plano: string): Promise<string> {
    return Promise.resolve(`hash:${plano}`)
  }

  verify(hash: string, plano: string): Promise<boolean> {
    return Promise.resolve(hash === `hash:${plano}`)
  }
}

describe('RegisterUseCase', () => {
  let usuarios: UserRepositoryEnMemoria
  let cola: InMemoryQueueAdapter
  let caso: RegisterUseCase

  beforeEach(() => {
    usuarios = new UserRepositoryEnMemoria()
    cola = new InMemoryQueueAdapter()
    caso = new RegisterUseCase(usuarios, new HasherDePrueba(), cola)
  })

  it('registra al usuario y nunca devuelve su hash', async () => {
    const usuario = await caso.ejecutar({
      email: 'ana@test.com',
      password: 'clave-larga-de-verdad',
      fullName: 'Ana',
    })

    expect(usuario.id).not.toBe('')
    expect(usuario.fullName).toBe('Ana')
    expect(usuario.emailVerifiedAt).toBeNull()
    expect(usuario).not.toHaveProperty('passwordHash')
    // Y la contraseña se guardó hasheada, no en claro.
    expect((await usuarios.findByEmail('ana@test.com'))?.passwordHash).toBe(
      'hash:clave-larga-de-verdad',
    )
  })

  it('normaliza el email: el usuario queda guardado en minúsculas y sin espacios', async () => {
    const usuario = await caso.ejecutar({
      email: '  Ana@TEST.com ',
      password: 'clave-larga-de-verdad',
      fullName: 'Ana',
    })

    expect(usuario.email).toBe('ana@test.com')
    // Y se encuentra escribiéndolo de cualquier forma: si no se normalizara,
    // el mismo humano podría registrarse dos veces con "la misma" dirección.
    expect(await usuarios.findByEmail('ANA@test.com')).not.toBeNull()
  })

  it('encola el correo de verificación en `email`, con jobId sin `:`', async () => {
    const usuario = await caso.ejecutar({
      email: 'ana@test.com',
      password: 'clave-larga-de-verdad',
      fullName: 'Ana',
    })

    const encolado = cola.encolados[0]
    expect(cola.encolados).toHaveLength(1)
    expect(encolado?.cola).toBe('email')
    expect(encolado?.nombre).toBe('verify-email')
    // BullMQ usa `:` como separador de claves de Redis y RECHAZA un customId
    // que lo contenga: `verify-email:<id>` lanzaría en `Queue.add`.
    expect(encolado?.jobId).toBe(`verify-email-${usuario.id}`)
    expect(encolado?.jobId).not.toContain(':')
  })

  it('el job lleva el email ya normalizado y un token de verificación', async () => {
    await caso.ejecutar({
      email: 'Ana@TEST.com',
      password: 'clave-larga-de-verdad',
      fullName: 'Ana',
    })

    const datos = cola.encolados[0]?.datos as { email: string; token: string; userId: string }
    expect(datos.email).toBe('ana@test.com')
    // Token de 32 bytes en hexadecimal: adivinable no es una opción.
    expect(datos.token).toMatch(/^[0-9a-f]{64}$/)
    expect(datos.userId).not.toBe('')
  })

  it('dos registros distintos reciben tokens de verificación distintos', async () => {
    await caso.ejecutar({ email: 'ana@test.com', password: 'clave-larga', fullName: 'Ana' })
    await caso.ejecutar({ email: 'luis@test.com', password: 'clave-larga', fullName: 'Luis' })

    const tokens = cola.encolados.map((e) => (e.datos as { token: string }).token)
    expect(new Set(tokens).size).toBe(2)
  })

  it('un email ya registrado lanza EmailYaRegistradoError y no encola nada nuevo', async () => {
    await caso.ejecutar({ email: 'ana@test.com', password: 'clave-larga', fullName: 'Ana' })

    await expect(
      // Con otra caja: la colisión se detecta sobre el email NORMALIZADO.
      caso.ejecutar({ email: 'ANA@test.com', password: 'otra-clave-larga', fullName: 'Otra Ana' }),
    ).rejects.toBeInstanceOf(EmailYaRegistradoError)

    expect(cola.encolados).toHaveLength(1)
  })
})
