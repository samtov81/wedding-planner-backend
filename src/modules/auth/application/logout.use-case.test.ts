import { SessionRepositoryEnMemoria } from '../infrastructure/session.repository.fake'
import { LogoutUseCase } from './logout.use-case'
import { hashToken } from './token.service'

describe('LogoutUseCase', () => {
  let sesiones: SessionRepositoryEnMemoria
  let caso: LogoutUseCase

  const MAÑANA = (): Date => new Date(Date.now() + 86_400_000)

  /** Siembra una sesión viva con su token EN CLARO, como la vería la cookie. */
  async function sembrar(token: string, familyId: string): Promise<void> {
    await sesiones.crear({
      userId: 'user-1',
      tokenHash: hashToken(token),
      familyId,
      expiresAt: MAÑANA(),
    })
  }

  beforeEach(() => {
    sesiones = new SessionRepositoryEnMemoria()
    caso = new LogoutUseCase(sesiones)
  })

  it('revoca la FAMILIA entera del refresh presentado, no sólo ese token', async () => {
    // Cerrar sesión cierra el dispositivo, no un eslabón de su cadena: el
    // refresh anterior de la misma familia tampoco puede seguir valiendo.
    await sembrar('refresh-viejo', 'familia-1')
    await sembrar('refresh-actual', 'familia-1')

    await caso.ejecutar('refresh-actual')

    expect(sesiones.familiaRevocada('familia-1')).toBe(true)
    expect(sesiones.estaRevocado('refresh-viejo')).toBe(true)
  })

  it('no toca las sesiones de OTRA familia: cerrar en un dispositivo no cierra los demás', async () => {
    await sembrar('refresh-movil', 'familia-1')
    await sembrar('refresh-portatil', 'familia-2')

    await caso.ejecutar('refresh-movil')

    expect(sesiones.familiaRevocada('familia-1')).toBe(true)
    expect(sesiones.estaRevocado('refresh-portatil')).toBe(false)
  })

  it('un refresh desconocido no lanza: cerrar sesión con una cookie caducada es un no-op', async () => {
    await sembrar('refresh-actual', 'familia-1')

    await expect(caso.ejecutar('token-que-nadie-emitio')).resolves.toBeUndefined()

    expect(sesiones.estaRevocado('refresh-actual')).toBe(false)
  })

  it('cerrar sesión DOS VECES con el mismo token no lanza la segunda', async () => {
    // El cliente puede reintentar el logout; un 500 ahí asusta sin motivo.
    await sembrar('refresh-actual', 'familia-1')

    await caso.ejecutar('refresh-actual')
    await expect(caso.ejecutar('refresh-actual')).resolves.toBeUndefined()

    expect(sesiones.familiaRevocada('familia-1')).toBe(true)
  })
})
