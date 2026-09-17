import { randomUUID } from 'node:crypto'

import type { SesionPersistida, SessionRepository } from '../application/session.repository'
import { hashToken } from '../application/token.service'

interface SesionInterna extends SesionPersistida {
  tokenHash: string
}

/**
 * Doble en memoria de `SessionRepository`, para tests de casos de uso sin
 * Prisma. Los helpers `estaRevocado`/`familiaRevocada` reciben el token EN
 * CLARO (como lo vería un test) y hashean internamente, igual que haría el
 * caso de uso real.
 */
export class SessionRepositoryEnMemoria implements SessionRepository {
  private sesiones: SesionInterna[] = []

  crear(datos: {
    userId: string
    tokenHash: string
    familyId: string
    expiresAt: Date
  }): Promise<void> {
    this.sesiones.push({
      id: randomUUID(),
      userId: datos.userId,
      tokenHash: datos.tokenHash,
      familyId: datos.familyId,
      expiresAt: datos.expiresAt,
      revokedAt: null,
    })
    return Promise.resolve()
  }

  buscarPorHash(tokenHash: string): Promise<SesionPersistida | null> {
    const sesion = this.sesiones.find((s) => s.tokenHash === tokenHash)
    if (sesion === undefined) return Promise.resolve(null)
    const { tokenHash: _oculto, ...publica } = sesion
    return Promise.resolve({ ...publica })
  }

  revocar(id: string): Promise<void> {
    const sesion = this.sesiones.find((s) => s.id === id)
    if (sesion !== undefined) sesion.revokedAt = new Date()
    return Promise.resolve()
  }

  revocarFamilia(familyId: string): Promise<void> {
    const ahora = new Date()
    for (const sesion of this.sesiones) {
      if (sesion.familyId === familyId && sesion.revokedAt === null) sesion.revokedAt = ahora
    }
    return Promise.resolve()
  }

  /** Helper de test: ¿la sesión que emitió este token en claro está revocada? */
  estaRevocado(token: string): boolean {
    const hash = hashToken(token)
    const sesion = this.sesiones.find((s) => s.tokenHash === hash)
    return sesion !== undefined && sesion.revokedAt !== null
  }

  /** Helper de test: ¿está revocada la familia entera? */
  familiaRevocada(familyId: string): boolean {
    const familia = this.sesiones.filter((s) => s.familyId === familyId)
    return familia.length > 0 && familia.every((s) => s.revokedAt !== null)
  }
}
