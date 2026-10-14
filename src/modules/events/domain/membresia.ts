import type { MembershipStatus } from './event-access'
import {
  CreadorIntocableError,
  MiembroNoEncontradoError,
  SinInvitacionPendienteError,
} from './event-errors'

/** Lo que las reglas de gestión necesitan saber de una membresía. */
export interface EstadoMembresia {
  status: MembershipStatus
  owner: boolean
}

/**
 * Revocar, cambiar el rol y conceder o retirar el presupuesto comparten la
 * misma precondición: una membresía viva (INVITED o ACTIVE) que no sea la del
 * creador. Una sola función para que ninguna de las tres la relaje.
 *
 * Genérica para que quien llama conserve sus propios campos tras la aserción
 * (el caso de uso necesita `membresia.id` después): con `EstadoMembresia` a
 * secas, el `asserts` estrecharía el tipo a sólo `status` y `owner`.
 */
export function exigirGestionable<T extends EstadoMembresia>(m: T | null): asserts m is T {
  if (m === null || m.status === 'REVOKED') throw new MiembroNoEncontradoError()
  if (m.owner) throw new CreadorIntocableError()
}

/** Aceptar y rechazar sólo existen desde INVITED. Genérica por lo mismo que la de arriba. */
export function exigirInvitacionPendiente<T extends { status: MembershipStatus }>(
  m: T | null,
): asserts m is T & { status: 'INVITED' } {
  if (m === null || m.status !== 'INVITED') throw new SinInvitacionPendienteError()
}
