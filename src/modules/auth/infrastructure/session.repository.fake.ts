import { randomUUID } from 'node:crypto'

import type {
  DatosNuevaSesion,
  SesionPersistida,
  SessionRepository,
} from '../application/session.repository'
import { hashToken } from '../application/token.service'

interface SesionInterna extends SesionPersistida {
  tokenHash: string
  ip: string | null
  userAgent: string | null
}

/**
 * Doble en memoria de `SessionRepository`, para tests de casos de uso sin
 * Prisma. Los helpers `estaRevocado`/`familiaRevocada` reciben el token EN
 * CLARO (como lo vería un test) y hashean internamente, igual que haría el
 * caso de uso real.
 *
 * `rotar` replica la MISMA semántica de compare-and-swap que el
 * adaptador de Prisma: sin eso, el doble no sirve para fijar la detección de
 * reuso por carrera, que es justo lo que se quiere probar sin base de datos.
 */
export class SessionRepositoryEnMemoria implements SessionRepository {
  private sesiones: SesionInterna[] = []

  crear(datos: DatosNuevaSesion): Promise<void> {
    this.insertar(datos)
    return Promise.resolve()
  }

  buscarPorHash(tokenHash: string): Promise<SesionPersistida | null> {
    const sesion = this.sesiones.find((s) => s.tokenHash === tokenHash)
    if (sesion === undefined) return Promise.resolve(null)
    const { tokenHash: _oculto, ip: _ip, userAgent: _ua, ...publica } = sesion
    return Promise.resolve({ ...publica })
  }

  rotar(datos: { sesionARevocar: string; nueva: DatosNuevaSesion }): Promise<boolean> {
    // El cuerpo entero es síncrono: es la versión en memoria de la
    // transacción, y nadie puede colarse entre el CAS y el insert.
    if (!this.revocarSiViva(datos.sesionARevocar)) return Promise.resolve(false)
    this.insertar(datos.nueva)
    return Promise.resolve(true)
  }

  revocarFamilia(familyId: string): Promise<void> {
    const ahora = new Date()
    for (const sesion of this.sesiones) {
      if (sesion.familyId === familyId && sesion.revokedAt === null) sesion.revokedAt = ahora
    }
    return Promise.resolve()
  }

  buscarSesionVivaDeFamilia(familyId: string): Promise<SesionPersistida | null> {
    const viva = this.sesiones.find((s) => s.familyId === familyId && s.revokedAt === null)
    if (viva === undefined) return Promise.resolve(null)
    const { tokenHash: _oculto, ip: _ip, userAgent: _ua, ...publica } = viva
    return Promise.resolve({ ...publica })
  }

  revocarTodasDeUsuario(userId: string): Promise<void> {
    const ahora = new Date()
    for (const sesion of this.sesiones) {
      if (sesion.userId === userId && sesion.revokedAt === null) sesion.revokedAt = ahora
    }
    return Promise.resolve()
  }

  /** Helper de test: cuántas sesiones vivas tiene el usuario. */
  vivasDeUsuario(userId: string): number {
    return this.sesiones.filter((s) => s.userId === userId && s.revokedAt === null).length
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

  /** Helper de test: la IP y el User-Agent guardados con este token en claro. */
  origenDe(token: string): { ip: string | null; userAgent: string | null } | null {
    const hash = hashToken(token)
    const sesion = this.sesiones.find((s) => s.tokenHash === hash)
    if (sesion === undefined) return null
    return { ip: sesion.ip, userAgent: sesion.userAgent }
  }

  /** Helper de test: cuántas sesiones se han creado en total. */
  cantidad(): number {
    return this.sesiones.length
  }

  private insertar(datos: DatosNuevaSesion): void {
    this.sesiones.push({
      id: randomUUID(),
      userId: datos.userId,
      tokenHash: datos.tokenHash,
      familyId: datos.familyId,
      expiresAt: datos.expiresAt,
      revokedAt: null,
      ip: datos.ip ?? null,
      userAgent: datos.userAgent ?? null,
    })
  }

  /** CAS en memoria: sólo el primero en llegar revoca y devuelve `true`. */
  private revocarSiViva(id: string): boolean {
    const sesion = this.sesiones.find((s) => s.id === id)
    if (sesion === undefined || sesion.revokedAt !== null) return false
    sesion.revokedAt = new Date()
    return true
  }
}
