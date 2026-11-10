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
  /**
   * `owner`: es quien creó el evento (`Event.ownerId`). No es un rol ni una
   * fuente de acceso aparte: sólo lo lleva quien ya tiene membresía ACTIVE,
   * y lo que añade es el permiso `OWNER`. Un segundo COUPLE invitado tiene
   * el mismo rol, pero no es owner.
   *
   * `budgetView`: el creador le concedió ver el presupuesto
   * (`event_budget_grants`). Sale de la MISMA lectura que la membresía.
   */
  | { kind: 'member'; role: EventRole; owner: boolean; budgetView: boolean }
  | { kind: 'vendor'; eventVendorId: string }
  | { kind: 'none' }

export function tieneAlgunAcceso(acceso: EventAccess): boolean {
  return acceso.kind !== 'none'
}

/**
 * Lo que `@RequireEventAccess()` sabe nombrar. `VENDOR` no es un `EventRole`
 * —no existe como membresía— pero sí es una forma de estar en el evento, así
 * que las rutas tienen que poder permitirlo o excluirlo igual que a los otros.
 * `OWNER` tampoco es un rol: lo tiene, además del suyo, el miembro que creó
 * el evento (ver `EventAccess`). `BUDGET_VIEW` y `BUDGET_EDIT` tampoco son
 * roles: se derivan de `accesoAlPresupuesto`.
 */
export type PermisoDeEvento = EventRole | 'VENDOR' | 'OWNER' | 'BUDGET_VIEW' | 'BUDGET_EDIT'

/**
 * Los permisos con los que se compara en las rutas. Una lista y no una sola
 * etiqueta porque el creador es a la vez `PLANNER` y `OWNER`. `admin` no
 * aparece aquí a propósito: se resuelve antes, saltándose la lista.
 */
export function permisosDe(acceso: EventAccess): PermisoDeEvento[] {
  if (acceso.kind === 'vendor') return ['VENDOR']
  if (acceso.kind !== 'member') return []
  const base: PermisoDeEvento[] = acceso.owner ? [acceso.role, 'OWNER'] : [acceso.role]
  const presupuesto = accesoAlPresupuesto(acceso)
  if (presupuesto === 'edit') return [...base, 'BUDGET_VIEW', 'BUDGET_EDIT']
  if (presupuesto === 'view') return [...base, 'BUDGET_VIEW']
  return base
}

/**
 * "Planner" a efectos de producto: ADMIN, o miembro ACTIVE con rol `PLANNER`
 * (creador o invitado). Es la regla de quién ve y escribe las notas del
 * cronograma, asigna proveedores y mueve el estado (spec 2026-11-10 §3).
 *
 * Es un predicado y NO `@RequireEventAccess('PLANNER')`: `permisosDe(admin)`
 * es `[]`, así que el guard por permiso dejaría fuera al admin, y la decisión
 * a veces depende del cuerpo de la petición y la toma el caso de uso (la ruta
 * PATCH del cronograma es la misma para editar el título que para cambiar el
 * estado).
 *
 * El estado del cronograma: la pareja lo lee pero no lo cambia; sí sigue
 * creando, editando y borrando ítems, porque lo que se le quita es decir
 * "esto está hecho", no planificar.
 *
 * Mira el ROL, no `owner`: desde que el creador nace PLANNER, ser creador ya
 * implica ser planner, y los eventos antiguos —cuyo creador nació COUPLE— se
 * quedan como están a propósito (sin migración de datos). Si se mirara
 * `owner`, una pareja creadora de un evento antiguo seguiría cambiando
 * estados y la regla diría dos cosas según la antigüedad del evento.
 *
 * Sustituye a `puedeCambiarEstadoDelCronograma`, que tras la Task 8 ya no
 * tenía llamadas: dos nombres para la misma regla podían separarse.
 */
export function esPlannerDelEvento(acceso: EventAccess): boolean {
  if (acceso.kind === 'admin') return true
  return acceso.kind === 'member' && acceso.role === 'PLANNER'
}

/**
 * Qué puede hacer alguien con el presupuesto del evento (gastos, resumen,
 * total y lo asignado a proveedores). Lo edita sólo el creador; él puede
 * conceder `view` a cada miembro por separado (`event_budget_grants`). ADMIN,
 * como en el resto de permisos, lo puede todo.
 */
export type BudgetAccess = 'none' | 'view' | 'edit'

/**
 * LA regla, una sola vez. Las dos funciones públicas la consultan con lo que
 * cada una sabe: el evento suelto tiene un `EventAccess`; el listado sólo el
 * creador de cada evento, quién pregunta y si tiene grant. Que ambas pasen por
 * aquí es lo que impide que el listado y el detalle enseñen cosas distintas.
 */
function reglaPresupuesto(quien: {
  admin: boolean
  owner: boolean
  budgetView: boolean
}): BudgetAccess {
  if (quien.admin || quien.owner) return 'edit'
  return quien.budgetView ? 'view' : 'none'
}

export function accesoAlPresupuesto(acceso: EventAccess): BudgetAccess {
  if (acceso.kind === 'admin') {
    return reglaPresupuesto({ admin: true, owner: false, budgetView: false })
  }
  if (acceso.kind !== 'member') return 'none'
  return reglaPresupuesto({ admin: false, owner: acceso.owner, budgetView: acceso.budgetView })
}

/**
 * La misma regla para `GET /events`. `budgetView` es el grant de la membresía
 * ACTIVE de quien pregunta en ese evento (false si llega por contratación).
 */
export function accesoAlPresupuestoEnListado(
  ownerId: string,
  userId: string,
  budgetView: boolean,
): BudgetAccess {
  return reglaPresupuesto({ admin: false, owner: ownerId === userId, budgetView })
}
