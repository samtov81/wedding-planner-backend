import type { Env } from '@/config/env.schema'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import type { PasswordHasher } from '@/modules/users/application/password-hasher.port'
import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { EmailVerificationTokenRepositoryFake } from '../infrastructure/email-verification-token.repository.fake'
import { RegisterUseCase } from './register.use-case'
import { hashToken } from './token.service'

/**
 * Doble mínimo de `PasswordHasher`: modela el hash como `hash:<plano>`. Lo que
 * aquí se prueba es el caso de uso, no Argon2, que tiene su propio test en
 * `argon2-password-hasher.test.ts` y cuesta cientos de milisegundos por llamada.
 * Cuenta sus llamadas porque la igualación de tiempos es parte del contrato.
 */
class HasherDePrueba implements PasswordHasher {
  llamadas = 0

  hash(plano: string): Promise<string> {
    this.llamadas += 1
    return Promise.resolve(`hash:${plano}`)
  }

  verify(hash: string, plano: string): Promise<boolean> {
    return Promise.resolve(hash === `hash:${plano}`)
  }
}

/** Sólo la variable que el caso de uso lee; el resto del Env no le incumbe. */
const ENV_DE_PRUEBA = { EMAIL_VERIFICATION_TTL_HOURS: 48 } as Env

interface PayloadVerificacion {
  userId: string
  tokenId: string
  email: string
  fullName: string
  token: string
}

describe('RegisterUseCase', () => {
  let usuarios: UserRepositoryEnMemoria
  let cola: InMemoryQueueAdapter
  let tokens: EmailVerificationTokenRepositoryFake
  let hasher: HasherDePrueba
  let caso: RegisterUseCase

  beforeEach(() => {
    usuarios = new UserRepositoryEnMemoria()
    cola = new InMemoryQueueAdapter()
    tokens = new EmailVerificationTokenRepositoryFake()
    hasher = new HasherDePrueba()
    caso = new RegisterUseCase(usuarios, hasher, cola, tokens, ENV_DE_PRUEBA)
  })

  it('registra al usuario y nunca devuelve su hash', async () => {
    const usuario = await caso.ejecutar({
      email: 'ana@test.com',
      password: 'clave-larga-de-verdad',
      fullName: 'Ana',
    })

    expect(usuario.id).not.toBe('')
    expect(usuario.fullName).toBe('Ana')
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
    const datos = encolado?.datos as PayloadVerificacion
    expect(cola.encolados).toHaveLength(1)
    expect(encolado?.cola).toBe('email')
    expect(encolado?.nombre).toBe('send-verification-email')
    // BullMQ usa `:` como separador de claves de Redis y RECHAZA un customId
    // que lo contenga: `verify-email:<id>` lanzaría en `Queue.add`. La clave
    // va por el id del TOKEN, no del usuario: ver el comentario en el caso de
    // uso y en EmailProcessor.
    expect(encolado?.jobId).toBe(`verify-email-${datos.tokenId}`)
    expect(encolado?.jobId).not.toContain(':')
    expect(encolado?.opciones.removeOnComplete).toBe(true)
    expect(datos.userId).toBe(usuario.id)
  })

  it('encola la verificación con el id del token en jobId y payload', async () => {
    await caso.ejecutar({ email: 'nueva@test.com', password: 'clave-larga', fullName: 'Nueva' })

    const encolado = cola.encolados.find((e) => e.nombre === 'send-verification-email')
    const datos = encolado?.datos as { tokenId?: string; token?: string }
    expect(datos.tokenId).toBeDefined()
    expect(encolado?.jobId).toBe(`verify-email-${datos.tokenId}`)
  })

  it('el job lleva el email ya normalizado y un token de verificación', async () => {
    await caso.ejecutar({
      email: 'Ana@TEST.com',
      password: 'clave-larga-de-verdad',
      fullName: 'Ana',
    })

    const datos = cola.encolados[0]?.datos as PayloadVerificacion
    expect(datos.email).toBe('ana@test.com')
    // 32 bytes en base64url, como el RSVP y el refresh: adivinarlo no es opción,
    // y sin `+`, `/` ni `=` viaja intacto como query param del enlace.
    expect(datos.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(datos.userId).not.toBe('')
  })

  it('lo persistido es el HASH del token que viaja en el job, nunca el token', async () => {
    const usuario = await caso.ejecutar({
      email: 'ana@test.com',
      password: 'clave-larga-de-verdad',
      fullName: 'Ana',
    })

    const { token } = cola.encolados[0]?.datos as PayloadVerificacion
    const fila = tokens.obtenerPorHash(hashToken(token))

    // Si esto se desalineara, el enlace del correo no verificaría nada. Y al
    // revés: la tabla no guarda el claro, así que un volcado no da enlaces.
    expect(fila).toBeDefined()
    expect(fila?.userId).toBe(usuario.id)
    expect(fila?.status).toBe('PENDING')
    expect(tokens.obtenerPorHash(token)).toBeUndefined()
  })

  it('la caducidad del token sale de EMAIL_VERIFICATION_TTL_HOURS', async () => {
    const antes = Date.now()
    await caso.ejecutar({ email: 'ana@test.com', password: 'clave-larga', fullName: 'Ana' })

    const { token } = cola.encolados[0]?.datos as PayloadVerificacion
    const expiresAt = tokens.obtenerPorHash(hashToken(token))?.expiresAt.getTime() ?? 0

    expect(expiresAt).toBeGreaterThanOrEqual(antes + 48 * 3_600_000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000)
  })

  it('dos registros distintos reciben tokens de verificación distintos', async () => {
    await caso.ejecutar({ email: 'ana@test.com', password: 'clave-larga', fullName: 'Ana' })
    await caso.ejecutar({ email: 'luis@test.com', password: 'clave-larga', fullName: 'Luis' })

    const tokensEnClaro = cola.encolados.map((e) => (e.datos as PayloadVerificacion).token)
    expect(new Set(tokensEnClaro).size).toBe(2)
  })

  describe('email ya registrado', () => {
    /**
     * El 409 de antes convertía `/auth/register` en un oráculo de enumeración
     * de cuentas: bastaba mirar el status para saber quién está dado de alta.
     * Ahora las dos ramas devuelven lo mismo y la diferencia sólo la ve quien
     * lee el buzón de esa dirección.
     */
    let primero: { id: string; email: string; fullName: string }

    beforeEach(async () => {
      primero = await caso.ejecutar({
        email: 'ana@test.com',
        password: 'clave-larga',
        fullName: 'Ana',
      })
    })

    it('no lanza: devuelve la misma forma que un alta nueva, con los datos reales de la cuenta', async () => {
      // Con otra caja: la colisión se detecta sobre el email NORMALIZADO.
      const segundo = await caso.ejecutar({
        email: 'ANA@test.com',
        password: 'otra-clave-larga',
        fullName: 'Otra Ana',
      })

      expect(segundo).toEqual(primero)
      expect(segundo).not.toHaveProperty('passwordHash')
    })

    it('no crea un usuario nuevo ni toca la contraseña del existente', async () => {
      await caso.ejecutar({
        email: 'ANA@test.com',
        password: 'otra-clave-larga',
        fullName: 'Otra Ana',
      })

      const guardado = await usuarios.findByEmail('ana@test.com')
      expect(guardado?.id).toBe(primero.id)
      expect(guardado?.fullName).toBe('Ana')
      // Registrarse "encima" de una cuenta ajena no puede cambiarle la clave.
      expect(guardado?.passwordHash).toBe('hash:clave-larga')
    })

    it('encola el aviso a la cuenta existente, sin token ni enlace, y no un segundo correo de verificación', async () => {
      await caso.ejecutar({
        email: 'ANA@test.com',
        password: 'otra-clave-larga',
        fullName: 'Otra Ana',
      })

      const aviso = cola.encolados[1]
      expect(cola.encolados).toHaveLength(2)
      expect(aviso?.nombre).toBe('send-registration-notice')
      expect(aviso?.jobId).toBe(`registration-notice-${primero.id}`)
      expect(aviso?.jobId).not.toContain(':')
      // Nada accionable en el payload: quien recibe el aviso no puede verificar
      // una cuenta que no es suya, y el aviso no filtra nada a quien lo provocó.
      expect(aviso?.datos).not.toHaveProperty('token')
      expect(cola.encolados.filter((e) => e.nombre === 'send-verification-email')).toHaveLength(1)
    })

    it('no emite un token nuevo: la tabla se queda con el del alta original', async () => {
      await caso.ejecutar({
        email: 'ANA@test.com',
        password: 'otra-clave-larga',
        fullName: 'Otra Ana',
      })

      const { token } = cola.encolados[0]?.datos as PayloadVerificacion
      expect(tokens.obtenerPorHash(hashToken(token))?.status).toBe('PENDING')
    })
  })

  it('hashea la contraseña exactamente una vez sea cual sea la rama', async () => {
    // Igualación de tiempos, el mismo principio que el hash señuelo de
    // `LoginUseCase` aplicado al lado de escritura: si la rama "ya existe" se
    // ahorrara el Argon2, la diferencia de latencia volvería a delatar qué
    // correos están registrados, justo lo que el 201 uniforme viene a tapar.
    await caso.ejecutar({ email: 'ana@test.com', password: 'clave-larga', fullName: 'Ana' })
    expect(hasher.llamadas).toBe(1)

    await caso.ejecutar({ email: 'ana@test.com', password: 'otra-clave-larga', fullName: 'X' })
    expect(hasher.llamadas).toBe(2)
  })
})
