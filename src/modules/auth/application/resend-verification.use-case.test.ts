import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { EmailVerificationTokenRepositoryFake } from '../infrastructure/email-verification-token.repository.fake'
import { hashToken } from './token.service'
import { ResendVerificationUseCase } from './resend-verification.use-case'

/**
 * El caso de uso ya NO espera (a propósito, ver su docblock) el trabajo de la
 * rama "cuenta pendiente" antes de devolver — es justo el fix del hallazgo
 * de temporización. Los tests que necesitan comprobar ESE trabajo (qué se
 * encoló, qué token se generó) tienen que dejar correr la cola de
 * microtareas después de `await caso.ejecutar(...)` antes de mirar `cola`.
 * `setTimeout(0)` basta: las promesas de los dobles en memoria se resuelven
 * sin E/S real, así que un macrotask vacío es suficiente para que la cadena
 * de `await` interna del trabajo en segundo plano termine.
 */
const dejarCorrerSegundoPlano = () => new Promise((resolver) => setTimeout(resolver, 0))

describe('ResendVerificationUseCase', () => {
  let usuarios: UserRepositoryEnMemoria
  let tokens: EmailVerificationTokenRepositoryFake
  let cola: InMemoryQueueAdapter
  let caso: ResendVerificationUseCase

  beforeEach(() => {
    usuarios = new UserRepositoryEnMemoria([
      {
        id: 'user-1',
        email: 'sinverificar@test.com',
        fullName: 'Sin Verificar',
        systemRole: 'USER',
        emailVerifiedAt: null,
        passwordHash: 'hash:x',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'user-2',
        email: 'verificada@test.com',
        fullName: 'Verificada',
        systemRole: 'USER',
        emailVerifiedAt: new Date('2026-01-01'),
        passwordHash: 'hash:x',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    tokens = new EmailVerificationTokenRepositoryFake()
    cola = new InMemoryQueueAdapter()
    caso = new ResendVerificationUseCase(usuarios, tokens, cola, {
      EMAIL_VERIFICATION_TTL_HOURS: 48,
    } as never)
  })

  it('encola un correo nuevo para una cuenta sin verificar', async () => {
    await caso.ejecutar({ email: 'sinverificar@test.com' })
    await dejarCorrerSegundoPlano()

    expect(cola.encolados).toHaveLength(1)
    const encolado = cola.encolados[0]
    expect(encolado?.nombre).toBe('send-verification-email')
    const datos = encolado?.datos as { tokenId: string; token: string; email: string }
    expect(datos.email).toBe('sinverificar@test.com')
    expect(encolado?.jobId).toBe(`verify-email-${datos.tokenId}`)
    expect(encolado?.opciones.removeOnComplete).toBe(true)
  })

  it('caduca los tokens vigentes antes de emitir el nuevo: sólo un enlace vivo', async () => {
    await caso.ejecutar({ email: 'sinverificar@test.com' })
    await dejarCorrerSegundoPlano()
    const primero = (cola.encolados[0]?.datos as { token: string }).token

    await caso.ejecutar({ email: 'sinverificar@test.com' })
    await dejarCorrerSegundoPlano()

    const consumo = await tokens.consumirPorHash(hashToken(primero), new Date())
    expect(consumo.resultado).toBe('NO_ENCONTRADO_O_CADUCADO')
  })

  it('no encola nada si la cuenta ya está verificada', async () => {
    await caso.ejecutar({ email: 'verificada@test.com' })
    expect(cola.encolados).toHaveLength(0)
  })

  it('no encola nada ni lanza si el email no existe', async () => {
    await expect(caso.ejecutar({ email: 'nadie@test.com' })).resolves.toBeUndefined()
    expect(cola.encolados).toHaveLength(0)
  })

  // Review Focus #5: sin normalizar, findByEmail no encuentra al usuario y el
  // reenvío falla en silencio — el usuario no recibe nada y nadie se entera.
  it('normaliza el email como hace el registro: mayúsculas y espacios', async () => {
    await caso.ejecutar({ email: '  SinVerificar@Test.com  ' })
    await dejarCorrerSegundoPlano()
    expect(cola.encolados).toHaveLength(1)
  })

  // Hallazgo importante #2 (revisión final de rama): antes de este fix, la
  // rama "pendiente" hacía tres operaciones de E/S más que "no existe" o "ya
  // verificada" ANTES de devolver — un canal de temporización que permite
  // enumerar cuentas cronometrando la respuesta, aunque el código y el cuerpo
  // sean idénticos. El test no puede medir milisegundos de forma fiable, así
  // que en su lugar comprueba la causa raíz: `ejecutar` debe resolver ANTES
  // de que el trabajo de la cuenta pendiente (caducar + crear + encolar)
  // haya siquiera empezado a tocar sus dependencias, para las tres formas de
  // cuenta. Si `ejecutar` volviera a esperar ese trabajo, `cola.encolados`
  // ya tendría el mensaje en el instante justo después del `await`, sin
  // necesidad de `dejarCorrerSegundoPlano()` — que es exactamente lo que las
  // otras pruebas de este fichero SÍ necesitan ahora.
  it('devuelve sin esperar el trabajo de la cuenta pendiente (cierra el canal de temporización)', async () => {
    await caso.ejecutar({ email: 'sinverificar@test.com' })

    // En el instante en que `ejecutar` resolvió, el trabajo en segundo plano
    // todavía no corrió: nada se encoló todavía.
    expect(cola.encolados).toHaveLength(0)

    await dejarCorrerSegundoPlano()
    expect(cola.encolados).toHaveLength(1)
  })
})
