export type EventRole = 'COUPLE' | 'PLANNER'

/** Estados de `EventMembership`. Sólo `ACTIVE` concede acceso. */
export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'REVOKED'

/**
 * Los DOS estados que conceden acceso a un evento, nombrados UNA sola vez.
 * La regla se consulta desde tres sitios —el acceso a un evento suelto, el
 * listado en SQL y el doble en memoria— y ninguno de los tres puede compartir
 * un predicado de verdad: uno es un `WHERE` que ejecuta Postgres y otro es un
 * `filter` sobre un array. Compartir al menos los literales quita la copia
 * más fácil de que derive: cambiar `ACTIVE` aquí rompe la compilación de todo
 * lo que no se haya actualizado. Lo que sujeta la FORMA de cada consulta son
 * los tests e2e de `GET /events` con INVITED, REVOKED y SHORTLISTED.
 */
export const MEMBRESIA_CON_ACCESO = 'ACTIVE' satisfies MembershipStatus
export const CONTRATACION_CON_ACCESO = 'BOOKED'

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
