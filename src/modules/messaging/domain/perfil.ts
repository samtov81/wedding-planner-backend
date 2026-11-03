import {
  AutocontactoError,
  ContactoYaAceptadoError,
  EsperaTrasRechazoError,
  RechazadoPorTiError,
  SolicitudPendienteError,
} from './messaging-errors'

/**
 * Reglas puras del contacto desde la ficha pública (spec 2026-11-03, §3 y §4.1).
 *
 * Una conversación `PROFILE` es un par (solicitante, dueño de la ficha) con
 * una solicitud que el proveedor acepta o rechaza. La clave de par es única y
 * simétrica, así que dos peticiones simultáneas chocan en el `UNIQUE` de
 * `pairKey`. Alternativa descartada: una clave por ficha (`vendorProfileId`):
 * el par ya identifica la ficha, porque cada proveedor tiene una sola.
 */
export type EstadoDeSolicitud = 'PENDING' | 'ACCEPTED' | 'DECLINED'

/** Espera tras un rechazo: exactamente 24 h desde `declinedAt`. */
export const ESPERA_TRAS_RECHAZO_MS = 86_400_000

export const claveDePerfil = (a: string, b: string): string =>
  a < b ? `profile:${a}:${b}` : `profile:${b}:${a}`

/** Lo que el dominio necesita saber de una conversación `PROFILE` existente. */
export interface ParDePerfil {
  conversationId: string
  requesterId: string
  vendorUserId: string
  status: EstadoDeSolicitud
  declinedAt: Date | null
}

/** Primer instante en que quien fue rechazado puede volver a pedir. */
export const reintentoEn = (declinedAt: Date): Date =>
  new Date(declinedAt.getTime() + ESPERA_TRAS_RECHAZO_MS)

/**
 * Decide qué hace `POST contact`. Orden: autocontacto; sin par, crear
 * (aceptada si ya están `relacionados`, p. ej. comparten un evento); pendiente
 * (sea quien sea el solicitante) y aceptada son 409; si rechazó quien ahora
 * pide, no puede; con relación se reabre aceptada sin esperar; si no, rige la
 * espera de 24 h. Lanza el error de dominio que toque.
 */
export function evaluarSolicitud(e: {
  solicitante: string
  duenoDeFicha: string
  par: ParDePerfil | null
  relacionados: boolean
  ahora: Date
}): { accion: 'crear' | 'reintentar'; estado: 'PENDING' | 'ACCEPTED' } {
  if (e.solicitante === e.duenoDeFicha) throw new AutocontactoError()
  const { par } = e
  if (par === null) return { accion: 'crear', estado: e.relacionados ? 'ACCEPTED' : 'PENDING' }
  if (par.status === 'PENDING') throw new SolicitudPendienteError()
  if (par.status === 'ACCEPTED') throw new ContactoYaAceptadoError(par.conversationId)
  if (e.solicitante !== par.requesterId) throw new RechazadoPorTiError()
  if (e.relacionados) return { accion: 'reintentar', estado: 'ACCEPTED' }
  // `declinedAt` lo garantiza el CHECK `conversations_perfil_rechazo`.
  const reintento = reintentoEn(par.declinedAt ?? e.ahora)
  if (e.ahora < reintento) throw new EsperaTrasRechazoError(reintento)
  return { accion: 'reintentar', estado: 'PENDING' }
}

export type EstadoDeContacto =
  'NONE' | 'PENDING_SENT' | 'PENDING_RECEIVED' | 'ACCEPTED' | 'DECLINED' | 'DECLINED_BY_ME' | 'SELF'

/** Estado de contacto entre `yo` y la ficha, tal como lo ve `yo`. */
export function estadoDeContacto(
  yo: string,
  duenoDeFicha: string,
  par: ParDePerfil | null,
): { state: EstadoDeContacto; conversationId: string | null; retryAt: Date | null } {
  if (yo === duenoDeFicha) return { state: 'SELF', conversationId: null, retryAt: null }
  if (par === null) return { state: 'NONE', conversationId: null, retryAt: null }
  const conversationId = par.conversationId
  if (par.status === 'PENDING') {
    const state = par.requesterId === yo ? 'PENDING_SENT' : 'PENDING_RECEIVED'
    return { state, conversationId, retryAt: null }
  }
  if (par.status === 'ACCEPTED') return { state: 'ACCEPTED', conversationId, retryAt: null }
  if (par.requesterId === yo) {
    return {
      state: 'DECLINED',
      conversationId,
      retryAt: par.declinedAt === null ? null : reintentoEn(par.declinedAt),
    }
  }
  return { state: 'DECLINED_BY_ME', conversationId, retryAt: null }
}

/** ¿Puede `userId` ver la conversación? El solicitante siempre; el proveedor salvo DECLINED. */
export function veConversacionDePerfil(par: ParDePerfil, userId: string): boolean {
  if (userId === par.requesterId) return true
  return userId === par.vendorUserId && par.status !== 'DECLINED'
}
