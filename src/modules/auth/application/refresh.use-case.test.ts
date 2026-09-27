import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { RefreshInvalidoError, RefreshReutilizadoError } from '../domain/token-errors'
import { SessionRepositoryEnMemoria } from '../infrastructure/session.repository.fake'
import { RefreshUseCase } from './refresh.use-case'
import { TokenService } from './token.service'

describe('RefreshUseCase', () => {
  const tokens = new TokenService({
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    JWT_ACCESS_TTL: '15m',
    REFRESH_TTL_DAYS: 30,
  })
  let sesiones: SessionRepositoryEnMemoria
  let usuarios: UserRepositoryEnMemoria
  let caso: RefreshUseCase

  beforeEach(() => {
    sesiones = new SessionRepositoryEnMemoria()
    usuarios = new UserRepositoryEnMemoria([
      {
        id: 'user-1',
        email: 'a@test.com',
        fullName: 'A',
        systemRole: 'USER',
        emailVerifiedAt: null,
        passwordHash: 'irrelevante',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    caso = new RefreshUseCase(sesiones, usuarios, tokens)
  })

  async function emitirPrimero(): Promise<string> {
    const { token, hash } = tokens.generarRefresh()
    await sesiones.crear({
      userId: 'user-1',
      tokenHash: hash,
      familyId: 'familia-1',
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    return token
  }

  it('rota el refresh: devuelve uno nuevo y revoca el usado', async () => {
    const primero = await emitirPrimero()

    const resultado = await caso.ejecutar(primero)

    expect(resultado.refreshToken).not.toBe(primero)
    expect(resultado.accessToken).toMatch(/^eyJ/)
    expect(sesiones.estaRevocado(primero)).toBe(true)
  })

  // Fix crítico #1 (revisión final de rama): sin ventana de gracia, dos
  // pestañas con la misma cookie de refresh (o un doble-reload en red lenta)
  // se trataban como ladrón + víctima y las dos acababan deslogueadas. Este
  // test ya NO simula reuso genuino instantáneo — eso ahora vive en el test
  // "pasada la ventana de gracia" de más abajo, con el reloj adelantado de
  // verdad — sino el caso que la ventana existe para cubrir: la revocación es
  // recientísima y la sucesora sigue viva.
  it('presentar el token justo tras rotarlo (sucesora viva y reciente) NO tumba la familia', async () => {
    const primero = await emitirPrimero()
    await caso.ejecutar(primero)

    // El "ladrón" aquí es en realidad la segunda pestaña del mismo cliente:
    // llega inmediatamente después de que la primera ya rotó.
    const resultado = await caso.ejecutar(primero)

    expect(resultado.accessToken).toMatch(/^eyJ/)
    expect(resultado.refreshToken).toEqual(expect.any(String))
    expect(sesiones.familiaRevocada('familia-1')).toBe(false)
  })

  it('pasada la ventana de gracia, presentar un token ya rotado SÍ es reuso y tumba la familia', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
      const primero = await emitirPrimero()
      const { refreshToken: segundo } = await caso.ejecutar(primero)

      // Once segundos después: fuera de los diez de la ventana de gracia. Ya
      // no es plausible que sea la pestaña gemela del mismo arranque — es
      // reuso de verdad.
      vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 11))
      await expect(caso.ejecutar(primero)).rejects.toThrow(RefreshReutilizadoError)

      // Y el ladrón no puede seguir usando el que sí era válido: cae la
      // familia entera, incluida la sesión que de verdad era legítima.
      await expect(caso.ejecutar(segundo)).rejects.toThrow()
      expect(sesiones.familiaRevocada('familia-1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dos rotaciones CONCURRENTES del mismo token: las dos obtienen tokens válidos, la familia sigue viva', async () => {
    const primero = await emitirPrimero()

    // Las dos peticiones leen la sesión ANTES de que ninguna la revoque, así
    // que ambas ven `revokedAt === null`: la comprobación de reuso por lectura
    // no las distingue. Lo único que puede hacerlo es el compare-and-swap de
    // `rotar`, que sólo una de las dos puede ganar — pero perder esa carrera
    // ya no es, por sí solo, la firma de un robo: dentro de la ventana de
    // gracia, la perdedora simplemente rota la sucesora una vez más y sigue.
    const resultados = await Promise.allSettled([caso.ejecutar(primero), caso.ejecutar(primero)])

    const cumplidos = resultados.filter(
      (r): r is PromiseFulfilledResult<{ accessToken: string; refreshToken: string }> =>
        r.status === 'fulfilled',
    )
    expect(cumplidos).toHaveLength(2)
    const [primeroCumplido, segundoCumplido] = cumplidos
    expect(primeroCumplido?.value.refreshToken).not.toBe(segundoCumplido?.value.refreshToken)

    // Ninguna de las dos pestañas hizo nada malo: la familia sigue en pie.
    expect(sesiones.familiaRevocada('familia-1')).toBe(false)
  })

  // Fix crítico #2 (revisión final de rama): la ventana de gracia comprueba
  // que la SUCESORA siga viva y sin caducar, pero nunca comprobaba que el
  // token PRESENTADO no estuviera él mismo caducado. Es un caso estrecho —
  // exige que el token se haya rotado dentro de los diez segundos previos a
  // SU PROPIA caducidad— pero es real: si alguien presenta un refresh que
  // está a la vez revocado (dentro de la ventana) y caducado, hoy se le
  // canjea igualmente por un refresh nuevo de 30 días, porque
  // `intentarContinuarComoConcurrente` sólo mira la caducidad de la sucesora,
  // nunca la del propio token presentado. Un token caducado no debe ser
  // canjeable NUNCA, sea cual sea el estado de su familia.
  it('un token revocado dentro de la ventana de gracia pero YA CADUCADO no se canjea', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))

      // Se crea directamente (sin `emitirPrimero`) para poder darle una
      // caducidad artificialmente corta: cinco segundos, en vez de los 30
      // días reales, de forma que pueda quedar en el pasado sin tener que
      // avanzar el reloj más allá de la ventana de gracia de diez segundos.
      const { token: primero, hash } = tokens.generarRefresh()
      await sesiones.crear({
        userId: 'user-1',
        tokenHash: hash,
        familyId: 'familia-2',
        expiresAt: new Date(Date.now() + 5_000),
      })

      // Se rota una vez: esto revoca `primero` y crea una sucesora viva con
      // caducidad de 30 días, exactamente el escenario que activa la
      // ventana de gracia.
      await caso.ejecutar(primero)

      // Seis segundos después: la revocación de `primero` sigue dentro de la
      // ventana de gracia (10s), pero su propia `expiresAt` (a los 5s) ya
      // quedó atrás. La sucesora, en cambio, sigue viva y muy lejos de
      // caducar.
      vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 6))

      await expect(caso.ejecutar(primero)).rejects.toThrow(RefreshInvalidoError)

      // Un token caducado no es, por sí solo, evidencia de robo — el mismo
      // criterio que ya aplica el camino sin ventana de gracia (test
      // "rechaza un refresh caducado" más abajo), que tampoco tumba la
      // familia. Tumbar la familia aquí penalizaría al cliente legítimo por
      // no haber refrescado a tiempo, no por haber sido robado.
      expect(sesiones.familiaRevocada('familia-2')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rechaza un refresh que no existe', async () => {
    await expect(caso.ejecutar('inventado')).rejects.toThrow(RefreshInvalidoError)
  })

  it('rechaza un refresh caducado', async () => {
    const { token, hash } = tokens.generarRefresh()
    await sesiones.crear({
      userId: 'user-1',
      tokenHash: hash,
      familyId: 'familia-1',
      expiresAt: new Date(Date.now() - 1_000),
    })

    await expect(caso.ejecutar(token)).rejects.toThrow(RefreshInvalidoError)
  })
})
