export type EventRole = 'COUPLE' | 'PLANNER'

/** Estados de `EventMembership`. Sólo `ACTIVE` concede acceso. */
export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'REVOKED'

/**
 * Acceso EFECTIVO de un usuario a un evento, resuelto sobre las dos fuentes
 * que existen: la membresía (quien planifica) y la contratación (quien trabaja).
 * Es una unión discriminada a propósito: obliga a quien lo consume a decidir
 * qué hace en cada caso, en vez de un booleano que pierde la razón del acceso.
 */
export type EventAccess =
  | { kind: 'admin' }
  | { kind: 'member'; role: EventRole }
  | { kind: 'vendor'; eventVendorId: string }
  | { kind: 'none' }

export function tieneAlgunAcceso(acceso: EventAccess): boolean {
  return acceso.kind !== 'none'
}

/**
 * Lo que `@RequireEventAccess()` sabe nombrar. `VENDOR` no es un `EventRole`
 * —no existe como membresía— pero sí es una forma de estar en el evento, así
 * que las rutas tienen que poder permitirlo o excluirlo igual que a los otros.
 */
export type PermisoDeEvento = EventRole | 'VENDOR'

/**
 * Colapsa el acceso a la etiqueta con la que se compara en las rutas. `admin`
 * no aparece aquí a propósito: se resuelve antes, saltándose la lista.
 */
export function etiquetaDe(acceso: EventAccess): PermisoDeEvento | null {
  if (acceso.kind === 'vendor') return 'VENDOR'
  if (acceso.kind === 'member') return acceso.role
  return null
}
