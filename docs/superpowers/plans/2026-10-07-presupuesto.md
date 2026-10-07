# Vista Budget y visibilidad del presupuesto — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar y consultar los gastos del evento en `/events/:eventId/expenses`, con totales por categoría, y hacer el presupuesto privado del creador en toda la API.

**Architecture:** Backend primero: una regla de dominio `accesoAlPresupuesto` alimenta dos permisos nuevos del guard (`BUDGET_VIEW`, `BUDGET_EDIT`) y el ocultado de importes; `budget-summary` gana `byCategory` agregado en Postgres. Frontend después: `getEvent` expone `budgetAccess`, que decide el menú, la tarjeta del dashboard y el modo (edición/lectura) de la nueva vista Budget; la vista ensambla tarjetas, lista paginada de gastos con filtros, panel por categoría y un modal de alta/edición.

**Tech Stack:** Backend NestJS + Prisma + zod + Vitest (+ Testcontainers en paridad/e2e). Frontend React 19, react-router 8, zustand, zod 4, Vitest + Testing Library.

**Spec:** `wedding-planner-backend/docs/superpowers/specs/2026-10-07-presupuesto-design.md`

## Global Constraints

- Ramas `feat/presupuesto` (ya creadas desde `develop`) en `wedding-planner-backend` y `wedding-planner-frontend`; PR contra `develop`, primero el backend.
- Backend: patrón de capas del repo (use case con `ejecutar`, puerto con Symbol, adaptador Prisma, fake `*.fake.ts` con test de paridad); errores de dominio y comentarios en español; montos como string decimal con 2 decimales y aritmética en céntimos (`aCentimos`/`deCentimos` de `@/shared/domain`).
- Backend gates: `npm test` (unit), `npm run test:e2e` si existe (si no, `npx vitest run test/e2e/<fichero>`), `npm run typecheck` (o `npx tsc --noEmit`), `npm run lint`. Leer `package.json` para los nombres exactos.
- Frontend: CLAUDE.md manda — sin `React.FC`; cero valores arbitrarios; sin `dark:`/`slate-*`; sin `<button>` crudo en `features/`; una `*-screen.tsx` sólo ensambla; textos de UI en inglés; comentarios y nombres de test en español; respuestas validadas con zod.
- Frontend gates: `npx vitest run <ficheros>`; al final `npm test && npm run typecheck && npm run lint`.
- Acceso al presupuesto: `BudgetAccess = 'none' | 'view' | 'edit'`. Creador (member owner) y admin → `'edit'`; el resto → `'none'`. `'view'` existe en tipos y UI pero nadie lo obtiene hasta la entrega 2.
- Sin acceso al evento → 404 (guard). Con acceso al evento pero sin permiso de presupuesto → 403 (guard).
- Ocultar sin acceso: `totalBudget: null` en `GET /events` y `GET /events/:id`; `assignedBudget: null` en `GET /events/:id/vendors`.
- Commits terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Un miembro COUPLE no creador abre el dashboard: no debe aparecer la tarjeta Budget ni pedirse `budget-summary` (que ahora le da 403), y la tarjeta Vendors no debe romper con `assignedBudget: null`. → test en Task 6.
- Un gasto pagado en un evento con `totalBudget` nulo: tarjetas "Not set", porcentaje 0, sin `NaN`. → test en Task 9.
- Cambiar filtro mientras "Load more" está en vuelo: la respuesta vieja no debe mezclarse con la lista nueva. → test en Task 8.
- Editar un gasto sin cambiar nada: no se manda un `PATCH {}` (la API responde 400 "Indica al menos un cambio"). → test en Task 10.
- Categorías con mayúsculas distintas ("Flowers" / "flowers") salen como dos filas en `byCategory` (decisión del spec); el datalist debe ofrecer las existentes para evitarlo. → test en Task 10.

---

## File Structure

Backend (`wedding-planner-backend`):

```
src/modules/events/domain/presupuesto.ts (+test)       BudgetAccess, accesoAlPresupuesto, accesoAlPresupuestoEnListado
src/modules/events/domain/event-access.ts              permisosDe añade BUDGET_VIEW / BUDGET_EDIT
src/modules/expenses/application/expense.repository.ts sumasPorCategoria
src/modules/expenses/infrastructure/{prisma-expense.repository,expense.repository.fake}.ts (+paridad)
src/modules/expenses/domain/expense.ts (+test)         byCategory en calcularResumen
src/modules/expenses/application/budget-summary.use-case.ts
src/modules/expenses/interfaces/expenses.controller.ts permisos de presupuesto
src/modules/events/interfaces/events.controller.ts     totalBudget oculto + budgetAccess
src/modules/vendors/interfaces/event-vendors.controller.ts assignedBudget oculto
test/e2e/budget-visibility.e2e.test.ts                 visibilidad de punta a punta
```

Frontend (`wedding-planner-frontend`):

```
src/features/event-config/event-api.ts (+test)         getEvent → budgetAccess
src/features/event-config/budget-summary-api.ts (+test) getBudgetSummary con byCategory (sale de dashboard-api)
src/features/dashboard/*                               tarjeta Budget según budgetAccess
src/app/app-layout.tsx (+test)                         ítem Budget
src/app/expenses-route.tsx (+test), src/app/router.tsx ruta /events/:eventId/expenses
src/features/event-setup/budget-step.tsx               enlace "Record expenses"
src/features/budget/expenses-api.ts (+test)            list/create/update/delete
src/features/budget/use-expense-list.ts (+test)        lista paginada con filtros
src/features/budget/budget-summary-card.tsx (+test)    tarjeta con moneda y "Not set"
src/features/budget/expense-row.tsx (+test)            fila de un gasto
src/features/budget/category-breakdown.tsx (+test)     panel "By category"
src/features/budget/expense-form-modal.tsx (+test)     alta/edición
src/features/budget/delete-expense-modal.tsx (+test)   confirmación
src/features/budget/budget-screen.tsx (+test)          ensambla
(borrar) src/features/budget/{mocks,savings-impact-card}.ts(x) y sus tests
```

---

## Backend

### Task 1: regla de acceso al presupuesto

**Repo:** `wedding-planner-backend`

**Files:**
- Create: `src/modules/events/domain/presupuesto.ts`, `src/modules/events/domain/presupuesto.test.ts`
- Modify: `src/modules/events/domain/event-access.ts` (`PermisoDeEvento`, `permisosDe`), `src/modules/events/domain/event-access.test.ts`

**Interfaces:**
- Produces: `type BudgetAccess = 'none' | 'view' | 'edit'`; `accesoAlPresupuesto(acceso: EventAccess): BudgetAccess`; `accesoAlPresupuestoEnListado(ownerId: string, userId: string): BudgetAccess`; `PermisoDeEvento` incluye `'BUDGET_VIEW' | 'BUDGET_EDIT'`.

- [ ] **Step 1: Write the failing tests**

`presupuesto.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { accesoAlPresupuesto, accesoAlPresupuestoEnListado } from './presupuesto'

describe('accesoAlPresupuesto', () => {
  it.each([
    [{ kind: 'admin' } as const, 'edit'],
    [{ kind: 'member', role: 'COUPLE', owner: true } as const, 'edit'],
    [{ kind: 'member', role: 'COUPLE', owner: false } as const, 'none'],
    [{ kind: 'member', role: 'PLANNER', owner: false } as const, 'none'],
    [{ kind: 'vendor', eventVendorId: 'ev-v' } as const, 'none'],
    [{ kind: 'none' } as const, 'none'],
  ])('%o → %s', (acceso, esperado) => {
    expect(accesoAlPresupuesto(acceso)).toBe(esperado)
  })
})

describe('accesoAlPresupuestoEnListado', () => {
  it('el creador edita; cualquier otro no ve nada', () => {
    expect(accesoAlPresupuestoEnListado('u-1', 'u-1')).toBe('edit')
    expect(accesoAlPresupuestoEnListado('u-1', 'u-2')).toBe('none')
  })
})
```

En `event-access.test.ts` añadir:

```ts
describe('permisosDe — presupuesto', () => {
  it('el creador lleva BUDGET_VIEW y BUDGET_EDIT además de su rol y OWNER', () => {
    expect(permisosDe({ kind: 'member', role: 'COUPLE', owner: true })).toEqual([
      'COUPLE',
      'OWNER',
      'BUDGET_VIEW',
      'BUDGET_EDIT',
    ])
  })

  it('un miembro no creador y un vendor no llevan permisos de presupuesto', () => {
    expect(permisosDe({ kind: 'member', role: 'PLANNER', owner: false })).toEqual(['PLANNER'])
    expect(permisosDe({ kind: 'vendor', eventVendorId: 'x' })).toEqual(['VENDOR'])
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/modules/events/domain`
Expected: FAIL — `presupuesto` no existe; `permisosDe` no añade los permisos.

- [ ] **Step 3: Implementar**

`presupuesto.ts`:

```ts
import type { EventAccess } from './event-access'

/**
 * Qué puede hacer alguien con el presupuesto del evento (gastos, resumen,
 * total y lo asignado a proveedores). Es privado del creador: sólo él lo
 * edita, y la entrega 2 añadirá `view` para los miembros a los que se lo
 * conceda uno a uno. Hasta entonces `view` existe en el tipo pero nadie lo
 * obtiene. ADMIN, como en el resto de permisos, lo puede todo.
 */
export type BudgetAccess = 'none' | 'view' | 'edit'

export function accesoAlPresupuesto(acceso: EventAccess): BudgetAccess {
  if (acceso.kind === 'admin') return 'edit'
  if (acceso.kind === 'member' && acceso.owner) return 'edit'
  return 'none'
}

/**
 * La misma regla para `GET /events`, que no resuelve un `EventAccess` por
 * evento: sólo conoce el creador de cada uno y quién pregunta. Si la regla
 * de arriba cambia (entrega 2), esta cambia con ella.
 */
export function accesoAlPresupuestoEnListado(ownerId: string, userId: string): BudgetAccess {
  return ownerId === userId ? 'edit' : 'none'
}
```

`event-access.ts`: `export type PermisoDeEvento = EventRole | 'VENDOR' | 'OWNER' | 'BUDGET_VIEW' | 'BUDGET_EDIT'` (actualizar su docblock: los dos de presupuesto se derivan de `accesoAlPresupuesto`), y:

```ts
export function permisosDe(acceso: EventAccess): PermisoDeEvento[] {
  if (acceso.kind === 'vendor') return ['VENDOR']
  if (acceso.kind !== 'member') return []
  const base: PermisoDeEvento[] = acceso.owner ? [acceso.role, 'OWNER'] : [acceso.role]
  const presupuesto = accesoAlPresupuesto(acceso)
  if (presupuesto === 'edit') return [...base, 'BUDGET_VIEW', 'BUDGET_EDIT']
  if (presupuesto === 'view') return [...base, 'BUDGET_VIEW']
  return base
}
```

con `import { accesoAlPresupuesto } from './presupuesto'`. Si el import crea un ciclo de módulos que el linter de arquitectura rechace (`test/architecture/dependency-rules.test.ts`), mover `BudgetAccess`/`accesoAlPresupuesto` dentro de `event-access.ts` y dejar `presupuesto.ts` re-exportando; decirlo en el report.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/modules/events/domain && npx vitest run test/architecture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/events/domain
git commit -m "feat: regla de acceso al presupuesto y permisos BUDGET_VIEW/BUDGET_EDIT"
```

---

### Task 2: rutas de gastos con permisos de presupuesto

**Files:**
- Modify: `src/modules/expenses/interfaces/expenses.controller.ts`
- Create: `test/e2e/budget-visibility.e2e.test.ts`
- Modify (si hace falta): `test/e2e/expenses.e2e.test.ts`

**Interfaces:**
- Consumes: `BUDGET_VIEW`, `BUDGET_EDIT` (Task 1).

- [ ] **Step 1: Write the failing e2e**

`budget-visibility.e2e.test.ts` — misma estructura que `test/e2e/expenses.e2e.test.ts` (copiar su `beforeAll`/`afterAll`, `registrarYEntrar` y `crearEventoPublicado`). Usuarios: `ana` (creadora), `luis` (COUPLE no creador), `pia` (PLANNER), `dj` (proveedor contratado). Las membresías de `luis` y `pia` se crean directamente con Prisma porque aún no hay flujo de aceptar invitación:

```ts
await prisma.eventMembership.create({ data: { eventId: evento, userId: luis.id, role: 'COUPLE', status: 'ACTIVE' } })
await prisma.eventMembership.create({ data: { eventId: evento, userId: pia.id, role: 'PLANNER', status: 'ACTIVE' } })
```

El proveedor `dj` se crea como `EventVendor` BOOKED ligado a su `VendorProfile`: leer `test/e2e/event-access.e2e.test.ts` y copiar cómo siembra un vendor contratado.

Casos de esta tarea (los de importes ocultos se añaden en Task 4):

```ts
it('la creadora lista gastos, ve el resumen y crea/edita/borra', async () => {
  const auth = { Authorization: `Bearer ${ana.accessToken}` }
  await request(url).get(`/events/${evento}/expenses`).set(auth).expect(200)
  await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(200)
  const creado = await request(url)
    .post(`/events/${evento}/expenses`).set(auth)
    .send({ concept: 'Flores', category: 'Flowers', amount: '100', payeeName: 'Floristería' })
    .expect(201)
  const id = (creado.body as { id: string }).id
  await request(url).patch(`/events/${evento}/expenses/${id}`).set(auth).send({ status: 'PAID' }).expect(200)
  await request(url).delete(`/events/${evento}/expenses/${id}`).set(auth).expect(204)
})

it.each([
  ['COUPLE no creador', () => luis],
  ['PLANNER', () => pia],
  ['proveedor contratado', () => dj],
])('%s recibe 403 en lectura y escritura de gastos', async (_quien, usuario) => {
  const auth = { Authorization: `Bearer ${usuario().accessToken}` }
  await request(url).get(`/events/${evento}/expenses`).set(auth).expect(403)
  await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(403)
  await request(url)
    .post(`/events/${evento}/expenses`).set(auth)
    .send({ concept: 'X', category: 'Y', amount: '1', payeeName: 'Z' })
    .expect(403)
})

it('un usuario sin acceso al evento recibe 404', async () => {
  await request(url).get(`/events/${evento}/expenses`).set({ Authorization: `Bearer ${extrano.accessToken}` }).expect(404)
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/e2e/budget-visibility.e2e.test.ts` (leer `package.json`/`vitest.config.ts` por si los e2e usan otra config; usar el comando que use el repo).
Expected: FAIL — hoy COUPLE/PLANNER reciben 200.

- [ ] **Step 3: Implementar**

En `expenses.controller.ts`: `@RequireEventAccess('BUDGET_VIEW')` en `GET expenses` y `GET budget-summary`; `@RequireEventAccess('BUDGET_EDIT')` en `POST`, `PATCH` y `DELETE`. Añadir al docblock de la clase: "El presupuesto es privado del creador (`accesoAlPresupuesto`): leer exige `BUDGET_VIEW` y escribir `BUDGET_EDIT`; quien está en el evento sin ese permiso recibe 403."

Revisar `test/e2e/expenses.e2e.test.ts`: si algún caso espera 200/201 para un miembro no creador, ajustarlo a 403 (la creadora sigue igual).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/e2e/budget-visibility.e2e.test.ts test/e2e/expenses.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/expenses/interfaces/expenses.controller.ts test/e2e
git commit -m "feat: los gastos y el resumen exigen permiso de presupuesto"
```

---

### Task 3: `byCategory` en `budget-summary`

**Files:**
- Modify: `src/modules/expenses/application/expense.repository.ts` (puerto), `src/modules/expenses/infrastructure/prisma-expense.repository.ts`, `src/modules/expenses/infrastructure/expense.repository.fake.ts`, `src/modules/expenses/infrastructure/expense.repository.paridad.test.ts`
- Modify: `src/modules/expenses/domain/expense.ts`, `src/modules/expenses/domain/expense.test.ts`
- Modify: `src/modules/expenses/application/budget-summary.use-case.ts` (+ su test en `expenses.use-cases.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  // expense.repository.ts
  export interface SumaPorCategoria { category: string; status: ExpenseStatus; amount: string; count: number }
  sumasPorCategoria(eventId: string): Promise<SumaPorCategoria[]>
  // expense.ts
  export interface ResumenPorCategoria { category: string; paid: string; pending: string; total: string; count: number }
  // ResumenPresupuesto gana: byCategory: ResumenPorCategoria[]
  // calcularResumen recibe además: porCategoria: SumaPorCategoria[]
  ```

- [ ] **Step 1: Test de dominio (falla)**

En `expense.test.ts`:

```ts
describe('calcularResumen — byCategory', () => {
  const base = { currency: 'EUR', totalBudget: '1000.00', assigned: '0.00', paid: '0.00', pending: '0.00' }

  it('pliega pagado y pendiente por categoría, en céntimos, y ordena por total', () => {
    const r = calcularResumen({
      ...base,
      porCategoria: [
        { category: 'Flowers', status: 'PAID', amount: '100.10', count: 1 },
        { category: 'Flowers', status: 'PENDING', amount: '0.20', count: 2 },
        { category: 'Music', status: 'PENDING', amount: '500.00', count: 1 },
      ],
    })
    expect(r.byCategory).toEqual([
      { category: 'Music', paid: '0.00', pending: '500.00', total: '500.00', count: 1 },
      { category: 'Flowers', paid: '100.10', pending: '0.20', total: '100.30', count: 3 },
    ])
  })

  it('a igual total ordena por nombre', () => {
    const r = calcularResumen({
      ...base,
      porCategoria: [
        { category: 'B', status: 'PAID', amount: '10.00', count: 1 },
        { category: 'A', status: 'PAID', amount: '10.00', count: 1 },
      ],
    })
    expect(r.byCategory.map((c) => c.category)).toEqual(['A', 'B'])
  })

  it('sin gastos, byCategory vacío', () => {
    expect(calcularResumen({ ...base, porCategoria: [] }).byCategory).toEqual([])
  })
})
```

Actualizar las llamadas existentes a `calcularResumen` en ese fichero añadiendo `porCategoria: []`.

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/modules/expenses/domain` → FAIL.

- [ ] **Step 3: Implementar dominio**

En `expense.ts`:

```ts
export interface ResumenPorCategoria {
  category: string
  paid: string
  pending: string
  total: string
  count: number
}
```

`ResumenPresupuesto` gana `byCategory: ResumenPorCategoria[]`. `calcularResumen` recibe `porCategoria: SumaPorCategoria[]` (importar el tipo de `../application/expense.repository` sólo si las reglas de arquitectura lo permiten; si el dominio no puede depender de `application`, declarar `SumaPorCategoria` en `domain/expense.ts` y que el puerto lo importe de ahí) y añade:

```ts
function porCategoria(filas: SumaPorCategoria[]): ResumenPorCategoria[] {
  const acc = new Map<string, { paid: bigint; pending: bigint; count: number }>()
  for (const f of filas) {
    const actual = acc.get(f.category) ?? { paid: 0n, pending: 0n, count: 0 }
    if (f.status === 'PAID') actual.paid += aCentimos(f.amount)
    else actual.pending += aCentimos(f.amount)
    actual.count += f.count
    acc.set(f.category, actual)
  }
  return [...acc.entries()]
    .map(([category, s]) => ({ category, s, total: s.paid + s.pending }))
    .sort((a, b) => (a.total === b.total ? a.category.localeCompare(b.category) : a.total > b.total ? -1 : 1))
    .map(({ category, s, total }) => ({
      category,
      paid: deCentimos(s.paid),
      pending: deCentimos(s.pending),
      total: deCentimos(total),
      count: s.count,
    }))
}
```

(Si `aCentimos` devuelve `number` y no `bigint` en este repo, usar el tipo que devuelva; leer `@/shared/domain`.) `return { ..., byCategory: porCategoria(e.porCategoria) }`.

- [ ] **Step 4: Paridad del repositorio (falla)**

En `expense.repository.paridad.test.ts` añadir un caso con el mismo patrón que el de `sumas` existente:

```ts
it('sumasPorCategoria agrupa por categoría y estado', async () => {
  const eventId = await sembrarEvento()
  for (const [, repo] of sujetos()) {
    // sembrar 3 gastos en ambos sujetos con el helper del fichero:
    // Flowers PAID 100.10, Flowers PENDING 0.20, Music PENDING 500.00
  }
  for (const [nombre, repo] of sujetos()) {
    const filas = await repo.sumasPorCategoria(eventId)
    const ordenadas = [...filas].sort((a, b) => `${a.category}${a.status}`.localeCompare(`${b.category}${b.status}`))
    expect(ordenadas, nombre).toEqual([
      { category: 'Flowers', status: 'PAID', amount: '100.10', count: 1 },
      { category: 'Flowers', status: 'PENDING', amount: '0.20', count: 1 },
      { category: 'Music', status: 'PENDING', amount: '500.00', count: 1 },
    ])
  }
})
```

Leer el fichero para usar su helper real de creación de gastos (el bucle de siembra debe crear los mismos gastos en `doble` y `real`, como hacen los casos existentes).

- [ ] **Step 5: Run to verify fail** — `npx vitest run src/modules/expenses/infrastructure` → FAIL.

- [ ] **Step 6: Implementar repositorio**

Puerto: `sumasPorCategoria(eventId: string): Promise<SumaPorCategoria[]>`.

Prisma:

```ts
async sumasPorCategoria(eventId: string): Promise<SumaPorCategoria[]> {
  const grupos = await this.prisma.expense.groupBy({
    by: ['category', 'status'],
    where: { eventId },
    _sum: { amount: true },
    _count: { _all: true },
  })
  return grupos.map((g) => ({
    category: g.category,
    status: g.status,
    amount: (g._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
    count: g._count._all,
  }))
}
```

Fake:

```ts
sumasPorCategoria(eventId: string): Promise<SumaPorCategoria[]> {
  const acc = new Map<string, SumaPorCategoria>()
  for (const g of this.gastos.filter((x) => x.eventId === eventId)) {
    const clave = `${g.category}\u0000${g.status}`
    const actual = acc.get(clave) ?? { category: g.category, status: g.status, amount: '0.00', count: 0 }
    acc.set(clave, {
      ...actual,
      amount: deCentimos(aCentimos(actual.amount) + aCentimos(g.amount)),
      count: actual.count + 1,
    })
  }
  return Promise.resolve([...acc.values()])
}
```

Use case: `const [sumas, porCategoria] = await Promise.all([this.gastos.sumas(eventId), this.gastos.sumasPorCategoria(eventId)])` y `calcularResumen({ currency, totalBudget, ...sumas, porCategoria })`. Ajustar el test del use case (`expenses.use-cases.test.ts`) para comprobar que `byCategory` llega.

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run src/modules/expenses`
Expected: PASS (la paridad arranca Postgres con Testcontainers; puede tardar).

- [ ] **Step 8: Commit**

```bash
git add src/modules/expenses
git commit -m "feat: budget-summary devuelve los totales por categoría"
```

---

### Task 4: ocultar importes y exponer `budgetAccess`

**Files:**
- Modify: `src/modules/events/interfaces/events.controller.ts`
- Modify: `src/modules/vendors/interfaces/event-vendors.controller.ts`
- Modify: `test/e2e/budget-visibility.e2e.test.ts`

**Interfaces:**
- Consumes: `accesoAlPresupuesto`, `accesoAlPresupuestoEnListado`, `BudgetAccess` (Task 1).
- Produces (HTTP): `GET /events/:id` → `{ ...evento, access, budgetAccess }`; `totalBudget` y `assignedBudget` a `null` cuando `budgetAccess === 'none'`.

- [ ] **Step 1: Write the failing e2e** (añadir al fichero de Task 2; la creadora pone antes `totalBudget` y un proveedor con `assignedBudget` vía `PATCH /events/:id` y `POST /events/:id/vendors`)

```ts
it('la creadora ve total, asignado y budgetAccess edit', async () => {
  const auth = { Authorization: `Bearer ${ana.accessToken}` }
  const ev = await request(url).get(`/events/${evento}`).set(auth).expect(200)
  expect(ev.body).toMatchObject({ totalBudget: '30000.00', budgetAccess: 'edit' })
  const lista = await request(url).get('/events').set(auth).expect(200)
  expect((lista.body as Array<{ id: string; totalBudget: string | null }>).find((e) => e.id === evento)?.totalBudget).toBe('30000.00')
  const vendors = await request(url).get(`/events/${evento}/vendors`).set(auth).expect(200)
  expect((vendors.body as Array<{ assignedBudget: string | null }>)[0]?.assignedBudget).toBe('500.00')
})

it.each([
  ['COUPLE no creador', () => luis],
  ['PLANNER', () => pia],
])('%s no ve importes y recibe budgetAccess none', async (_quien, usuario) => {
  const auth = { Authorization: `Bearer ${usuario().accessToken}` }
  const ev = await request(url).get(`/events/${evento}`).set(auth).expect(200)
  expect(ev.body).toMatchObject({ totalBudget: null, budgetAccess: 'none' })
  const lista = await request(url).get('/events').set(auth).expect(200)
  expect((lista.body as Array<{ id: string; totalBudget: string | null }>).find((e) => e.id === evento)?.totalBudget).toBeNull()
  const vendors = await request(url).get(`/events/${evento}/vendors`).set(auth).expect(200)
  for (const v of vendors.body as Array<{ assignedBudget: string | null }>) expect(v.assignedBudget).toBeNull()
})

it('el proveedor contratado no ve el total', async () => {
  const ev = await request(url).get(`/events/${evento}`).set({ Authorization: `Bearer ${dj.accessToken}` }).expect(200)
  expect(ev.body).toMatchObject({ totalBudget: null, budgetAccess: 'none' })
})
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implementar**

`events.controller.ts`:
- `aRespuesta(evento: Event, presupuesto: BudgetAccess): EventoRespuesta` con `totalBudget: presupuesto === 'none' ? null : evento.totalBudget`.
- `crearEvento` y `editarEvento`/`publicarEvento` (siempre el creador): `this.aRespuesta(evento, 'edit')`.
- `listarEventos`: `eventos.map((e) => this.aRespuesta(e, accesoAlPresupuestoEnListado(e.ownerId, yo.id)))`.
- `verEvento`: `const presupuesto = accesoAlPresupuesto(acceso)`; devuelve `{ ...this.aRespuesta(evento, presupuesto), access: acceso, budgetAccess: presupuesto }` y amplía su tipo de retorno con `budgetAccess: BudgetAccess`.
- Comentario en `aRespuesta`: el total es dato del presupuesto (spec §3.2); `completitud` no se oculta porque no revela importes.

`event-vendors.controller.ts`, en `listarVendors`: añadir `@EventAccessOf() acceso: EventAccess | undefined` (mismo patrón que `verEvento`: si falta, `throw new Error('listarVendors requires EventAccessGuard')`), `const oculto = accesoAlPresupuesto(acceso) === 'none'` y `vendors.map((v) => this.aRespuesta(v, oculto))` con `assignedBudget: oculto ? null : vendor.assignedBudget`. Las rutas de escritura (OWNER) pasan `false`. Importar desde `@/modules/events/...` respetando las reglas de dependencia (el controlador ya importa del módulo de eventos).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/e2e/budget-visibility.e2e.test.ts test/e2e/events-draft.e2e.test.ts test/e2e/event-vendors.e2e.test.ts test/e2e/event-access.e2e.test.ts` y los unit de `src/modules/events` y `src/modules/vendors`.
Expected: PASS (ajustar asserts de tests existentes que esperen importes para un miembro no creador; decirlo en el report).

- [ ] **Step 5: Gates y commit**

Run: test unit + e2e del repo, typecheck, lint.

```bash
git add src/modules/events src/modules/vendors test/e2e
git commit -m "feat: el total y lo asignado se ocultan sin acceso al presupuesto; budgetAccess en el evento"
```

---

## Frontend

### Task 5: `budgetAccess` y `budget-summary-api`

**Repo:** `wedding-planner-frontend`

**Files:**
- Modify: `src/features/event-config/event-api.ts` (+ `event-api.test.ts`)
- Create: `src/features/event-config/budget-summary-api.ts`, `budget-summary-api.test.ts`
- Modify: `src/features/dashboard/dashboard-api.ts` (+ test), consumidores de `getBudgetSummary`/`BudgetSummary` (`dashboard-screen.tsx`, `dashboard-cards.tsx` y sus tests)

**Interfaces:**
- Produces:
  ```ts
  // event-model.ts
  export const budgetAccessSchema = z.enum(['none', 'view', 'edit'])
  export type BudgetAccess = z.infer<typeof budgetAccessSchema>
  // event-api.ts
  getEvent(id): Promise<{ event: EventSettings; isOwner: boolean; access: EventAccessKind; budgetAccess: BudgetAccess }>
  // budget-summary-api.ts
  export interface CategoryTotal { category: string; paid: string; pending: string; total: string; count: number }
  export type BudgetSummary = { currency: string; totalBudget: string | null; assigned: string; unassigned: string | null; paid: string; pending: string; remaining: string | null; byCategory: CategoryTotal[] }
  getBudgetSummary(eventId): Promise<BudgetSummary>
  ```

- [ ] **Step 1: Tests (fallan)**

`event-api.test.ts`: los fixtures de `GET /events/:id` ganan `budgetAccess: 'edit'`; añadir:

```ts
it('getEvent expone budgetAccess', async () => {
  apiGet.mockResolvedValue({ ...apiEvent, access: { kind: 'member', role: 'COUPLE', owner: false }, totalBudget: null, budgetAccess: 'none' })
  const r = await getEvent('ev-1')
  expect(r.budgetAccess).toBe('none')
  expect(r.event.totalBudget).toBeNull()
})

it('una respuesta sin budgetAccess se trata como none', async () => {
  apiGet.mockResolvedValue({ ...apiEvent, access: { kind: 'member', role: 'COUPLE', owner: true } })
  expect((await getEvent('ev-1')).budgetAccess).toBe('none')
})
```

`budget-summary-api.test.ts` (mock de `apiGet` como en `dashboard-api.test.ts`):

```ts
it('pide el resumen con sus totales por categoría', async () => {
  const body = {
    currency: 'EUR', totalBudget: '1000.00', assigned: '0.00', unassigned: '1000.00',
    paid: '100.00', pending: '50.00', remaining: '850.00',
    byCategory: [{ category: 'Flowers', paid: '100.00', pending: '50.00', total: '150.00', count: 2 }],
  }
  apiGet.mockResolvedValue(body)
  expect(await getBudgetSummary('ev 1')).toEqual(body)
  expect(apiGet).toHaveBeenCalledWith('/events/ev%201/budget-summary')
})

it('un backend antiguo sin byCategory da lista vacía', async () => {
  apiGet.mockResolvedValue({ currency: 'EUR', totalBudget: null, assigned: '0.00', unassigned: null, paid: '0.00', pending: '0.00', remaining: null })
  expect((await getBudgetSummary('ev-1')).byCategory).toEqual([])
})
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implementar**

`event-model.ts`: `budgetAccessSchema`/`BudgetAccess`. `event-api.ts` en `getEvent`: `const budgetAccess = budgetAccessSchema.catch('none').parse((body as { budgetAccess?: unknown }).budgetAccess)` (default prudente: sin el campo, nada se muestra) y devolverlo.

`budget-summary-api.ts`: mover `amount`, `budgetSummarySchema` y `getBudgetSummary` desde `dashboard-api.ts`; añadir

```ts
const categoryTotalSchema = z.object({
  category: z.string(),
  paid: amount,
  pending: amount,
  total: amount,
  count: z.number().int().nonnegative(),
})
// en budgetSummarySchema:
byCategory: z.array(categoryTotalSchema).default([]),
```

Borrar de `dashboard-api.ts` lo movido y su test; actualizar imports en dashboard (`../event-config/budget-summary-api`).

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/features/event-config src/features/dashboard && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/features/event-config src/features/dashboard
git commit -m "feat: budgetAccess del evento y resumen de presupuesto con totales por categoría"
```

---

### Task 6: menú, ruta, dashboard y enlace del asistente

**Files:**
- Modify: `src/app/app-layout.tsx` (+ test), `src/app/app-layout-icons.tsx`
- Create: `src/app/expenses-route.tsx` (+ test)
- Modify: `src/app/router.tsx` (+ `router.test.tsx`)
- Modify: `src/features/dashboard/dashboard-screen.tsx`, `dashboard-cards.tsx` (+ tests)
- Modify: `src/features/event-setup/budget-step.tsx` (+ test)
- Modify: `src/features/budget/budget-screen.tsx` (stub temporal, ver abajo)

**Interfaces:**
- Consumes: `getEvent(...).budgetAccess` (Task 5).
- Produces: `ExpensesRoute()` monta `<BudgetScreen key={eventId} eventId={eventId} />`; `BudgetScreenProps { eventId: string }`.

- [ ] **Step 1: Tests (fallan)**

`app-layout.test.tsx` — el mock de `getEvent` devuelve también `budgetAccess`; el helper `owner(isOwner)` pasa a `owner(isOwner, budgetAccess = isOwner ? 'edit' : 'none')`. Añadir la hija `/events/:eventId/expenses` en `renderAt`. Casos:

```ts
it('con acceso al presupuesto aparece Budget entre Seating Chart y Event setup', async () => {
  renderAt('/events/ev-1/guests')
  await waitFor(() =>
    expect(labels()).toEqual(['Dashboard', 'Guest List', 'Seating Chart', 'Budget', 'Event setup', 'Settings', 'Profile']),
  )
  expect(within(nav()).getByRole('link', { name: 'Budget' })).toHaveAttribute('href', '/events/ev-1/expenses')
})

it('sin acceso al presupuesto no aparece Budget', async () => {
  getEvent.mockResolvedValue(owner(false))
  renderAt('/events/ev-1/guests')
  await waitFor(() => expect(getEvent).toHaveBeenCalled())
  expect(labels()).not.toContain('Budget')
})

it('con acceso de sólo lectura aparece Budget aunque no sea el creador', async () => {
  getEvent.mockResolvedValue(owner(false, 'view'))
  renderAt('/events/ev-1/guests')
  await within(nav()).findByRole('link', { name: 'Budget' })
})
```

Actualizar las expectativas de `labels()` existentes del creador para incluir 'Budget'.

`dashboard-screen.test.tsx`:

```ts
it('un miembro sin acceso al presupuesto no ve la tarjeta Budget ni se pide el resumen', async () => {
  getEvent.mockResolvedValue({ event: { ...event, totalBudget: null }, isOwner: false, access: 'member', budgetAccess: 'none' })
  listEventVendors.mockResolvedValue([{ id: 'v', name: 'V', category: { id: 'c', slug: 'c', name: 'C' }, specialty: null, assignedBudget: null, status: 'BOOKED' }])
  renderScreen()
  expect(await screen.findByText('RSVP Status')).toBeInTheDocument()
  expect(await screen.findByText('Vendors Secured')).toBeInTheDocument()
  expect(screen.queryByText('Budget Overview')).not.toBeInTheDocument()
  expect(getBudgetSummary).not.toHaveBeenCalled()
})
```

(cambiar el mock de `./dashboard-api` → `../event-config/budget-summary-api` para `getBudgetSummary`; los fixtures del creador llevan `budgetAccess: 'edit'`.) En `dashboard-cards.test.tsx`: `BudgetCard` con datos enlaza "View expenses" a `/events/ev-1/expenses`.

`expenses-route.test.tsx`: mismo patrón que `dashboard-route.test.tsx` (mock de `../features/budget/budget-screen` pintando `budget ${eventId}`).

`budget-step.test.tsx`: existe un enlace "Record expenses" a `/events/ev-1/expenses`.

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implementar**

`app-layout.tsx`: `useIsOwner` pasa a `useEventPermissions(eventId): { isOwner: boolean; budgetAccess: BudgetAccess }` (mismo descarte de respuestas de otro evento; fallo → `{ isOwner: false, budgetAccess: 'none' }`). Ítem:

```tsx
...(budgetAccess !== 'none' ? [item('budget', 'Budget', `${base}/expenses`, <WalletIcon />)] : []),
```

entre Seating Chart y Event setup. `WalletIcon` en `app-layout-icons.tsx` con el mismo trazo que el `WalletIcon` de `features/budget/budget-icons.tsx` (copiar su path). Actualizar el docblock.

`expenses-route.tsx`:

```tsx
import { useParams } from 'react-router'
import { BudgetScreen } from '../features/budget/budget-screen'
import { NotFoundScreen } from '../features/system/not-found-screen'

/** Gastos del evento de la URL. `key`: montaje nuevo al cambiar de evento. */
export function ExpensesRoute() {
  const { eventId } = useParams()
  if (!eventId) return <NotFoundScreen inLayout />
  return <BudgetScreen key={eventId} eventId={eventId} />
}
```

`router.tsx`: `{ path: '/events/:eventId/expenses', element: <ExpensesRoute /> }` dentro de `AppLayout`.

`budget-screen.tsx` en esta tarea: sustituir el contenido por un stub que acepte `{ eventId }` y pinte `<main className="flex-1 p-12"><h2 className="text-2xl font-extrabold text-ink">Budget Manager</h2></main>`; borrar `budget-screen.test.tsx` actual (sus asserts son de la maqueta) y dejar un test mínimo del heading. Task 9 la reescribe.

Dashboard: `const canSeeBudget = ready !== null && ready.budgetAccess !== 'none'`; `useLoad(loadBudget, canSeeBudget)`; la sección Budget Overview sólo si `canSeeBudget`. `BudgetCard` gana un `CardLink` "View expenses" a `eventPath(eventId, 'expenses')` en su estado con datos.

`budget-step.tsx`: tras la barra de asignado, `<Button asChild variant="link" size="sm"><Link to={`/events/${encodeURIComponent(event.id)}/expenses`}>Record expenses</Link></Button>`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/app src/features/dashboard src/features/event-setup src/features/budget && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/app src/features/dashboard src/features/event-setup src/features/budget
git commit -m "feat: ruta y menú de Budget según el acceso al presupuesto"
```

---

### Task 7: `expenses-api`

**Files:**
- Create: `src/features/budget/expenses-api.ts`, `src/features/budget/expenses-api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ExpenseStatus = 'PENDING' | 'PAID'
  export type ExpenseOrigin =
    | { kind: 'vendor'; eventVendorId: string; vendorName: string }
    | { kind: 'external'; payeeName: string }
  export interface Expense {
    id: string; origin: ExpenseOrigin; concept: string; category: string; amount: string
    status: ExpenseStatus; dueDate: string | null; paidAt: string | null; notes: string | null; createdAt: string
  }
  export interface ExpenseFilters { status?: ExpenseStatus; origin?: 'vendor' | 'external' }
  export type ExpensePayee = { kind: 'vendor'; eventVendorId: string } | { kind: 'external'; payeeName: string }
  export interface NewExpense { concept: string; category: string; amount: string; payee: ExpensePayee; dueDate: string | null; status: ExpenseStatus; notes: string | null }
  export type ExpenseChanges = Partial<Omit<NewExpense, 'payee'>> & { payee?: ExpensePayee }
  listExpenses(eventId: string, filters: ExpenseFilters, cursor: string | null): Promise<{ items: Expense[]; nextCursor: string | null }>
  createExpense(eventId: string, input: NewExpense): Promise<Expense>
  updateExpense(eventId: string, expenseId: string, changes: ExpenseChanges): Promise<Expense>
  deleteExpense(eventId: string, expenseId: string): Promise<void>
  ```

- [ ] **Step 1: Tests (fallan)** — mock de `apiGet/apiPost/apiPatch/apiDelete` como en `event-api.test.ts`.

```ts
const apiExpense = {
  id: 'x-1', origin: { kind: 'external', payeeName: 'Floristería' }, concept: 'Ramo', category: 'Flowers',
  amount: '100.00', status: 'PENDING', dueDate: '2027-05-01', paidAt: null, notes: null, createdAt: '2026-10-07T10:00:00.000Z',
}

it('listExpenses manda filtros, cursor y límite 25', async () => {
  apiGet.mockResolvedValue({ items: [apiExpense], nextCursor: 'c2' })
  const r = await listExpenses('ev 1', { status: 'PENDING', origin: 'external' }, 'c1')
  expect(r).toEqual({ items: [apiExpense], nextCursor: 'c2' })
  expect(apiGet).toHaveBeenCalledWith('/events/ev%201/expenses?limit=25&status=PENDING&origin=external&cursor=c1')
})

it('listExpenses sin filtros sólo manda el límite', async () => {
  apiGet.mockResolvedValue({ items: [], nextCursor: null })
  await listExpenses('ev-1', {}, null)
  expect(apiGet).toHaveBeenCalledWith('/events/ev-1/expenses?limit=25')
})

it('createExpense traduce el pagador a eventVendorId o payeeName, nunca ambos', async () => {
  apiPost.mockResolvedValue(apiExpense)
  await createExpense('ev-1', { concept: 'Ramo', category: 'Flowers', amount: '100', payee: { kind: 'vendor', eventVendorId: 'v-1' }, dueDate: null, status: 'PENDING', notes: null })
  expect(apiPost).toHaveBeenCalledWith('/events/ev-1/expenses', { concept: 'Ramo', category: 'Flowers', amount: '100', eventVendorId: 'v-1', dueDate: null, status: 'PENDING', notes: null })
})

it('updateExpense manda sólo los cambios y el pagador nuevo', async () => {
  apiPatch.mockResolvedValue(apiExpense)
  await updateExpense('ev-1', 'x 1', { amount: '120', payee: { kind: 'external', payeeName: 'Otra' } })
  expect(apiPatch).toHaveBeenCalledWith('/events/ev-1/expenses/x%201', { amount: '120', payeeName: 'Otra' })
})

it('deleteExpense hace DELETE', async () => {
  apiDelete.mockResolvedValue(undefined)
  await deleteExpense('ev-1', 'x-1')
  expect(apiDelete).toHaveBeenCalledWith('/events/ev-1/expenses/x-1')
})

it('una respuesta con otra forma se rechaza', async () => {
  apiGet.mockResolvedValue({ items: [{ ...apiExpense, amount: 100 }], nextCursor: null })
  await expect(listExpenses('ev-1', {}, null)).rejects.toThrow()
})
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implementar**

```ts
import { z } from 'zod'
import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api-client'

/**
 * Gastos del evento (`/events/:id/expenses`). La API pagina por cursor (25
 * por página) y distingue el pagador por qué campo llega: `eventVendorId`
 * (proveedor del evento) o `payeeName` (tercero externo); mandar los dos o
 * ninguno es un 400, así que `payeeFields` produce exactamente uno.
 */
export const PAGE_SIZE = 25

const amount = z.string().regex(/^\d+(\.\d+)?$/)
const expenseSchema = z.object({
  id: z.string(),
  origin: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('vendor'), eventVendorId: z.string(), vendorName: z.string() }),
    z.object({ kind: z.literal('external'), payeeName: z.string() }),
  ]),
  concept: z.string(),
  category: z.string(),
  amount,
  status: z.enum(['PENDING', 'PAID']),
  dueDate: z.string().nullable(),
  paidAt: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
})
// …tipos exportados según Interfaces…

const base = (eventId: string) => `/events/${encodeURIComponent(eventId)}/expenses`

function payeeFields(payee: ExpensePayee) {
  return payee.kind === 'vendor' ? { eventVendorId: payee.eventVendorId } : { payeeName: payee.payeeName }
}

export async function listExpenses(eventId: string, filters: ExpenseFilters, cursor: string | null) {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (filters.status) query.set('status', filters.status)
  if (filters.origin) query.set('origin', filters.origin)
  if (cursor !== null) query.set('cursor', cursor)
  return z
    .object({ items: z.array(expenseSchema), nextCursor: z.string().nullable() })
    .parse(await apiGet(`${base(eventId)}?${query.toString()}`))
}

export async function createExpense(eventId: string, { payee, ...rest }: NewExpense): Promise<Expense> {
  return expenseSchema.parse(await apiPost(base(eventId), { ...rest, ...payeeFields(payee) }))
}

export async function updateExpense(eventId: string, expenseId: string, { payee, ...rest }: ExpenseChanges): Promise<Expense> {
  const body = payee === undefined ? rest : { ...rest, ...payeeFields(payee) }
  return expenseSchema.parse(await apiPatch(`${base(eventId)}/${encodeURIComponent(expenseId)}`, body))
}

export async function deleteExpense(eventId: string, expenseId: string): Promise<void> {
  await apiDelete(`${base(eventId)}/${encodeURIComponent(expenseId)}`)
}
```

Para que el orden de claves del body coincida con el test de `createExpense`, construir el objeto explícitamente: `{ concept, category, amount, ...payeeFields(payee), dueDate, status, notes }` (o usar `expect.objectContaining` + comprobar que no hay la otra clave — preferir el objeto explícito).

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/budget/expenses-api.ts src/features/budget/expenses-api.test.ts
git commit -m "feat: API de gastos del evento"
```

---

### Task 8: `useExpenseList` (paginación y filtros)

**Files:**
- Create: `src/features/budget/use-expense-list.ts`, `use-expense-list.test.tsx`

**Interfaces:**
- Consumes: `listExpenses`, `Expense`, `ExpenseFilters` (Task 7).
- Produces:
  ```ts
  export interface ExpenseListState {
    status: 'loading' | 'ready' | 'error'
    items: Expense[]
    nextCursor: string | null
    loadingMore: boolean
    loadMoreError: boolean
  }
  useExpenseList(eventId: string, filters: ExpenseFilters): {
    state: ExpenseListState
    loadMore: () => void
    reload: () => void            // vuelve a la primera página con los filtros actuales
    replace: (expense: Expense) => void  // sustituye una fila por id (Mark as paid)
  }
  ```

- [ ] **Step 1: Tests (fallan)**

```tsx
import { act, renderHook, waitFor } from '@testing-library/react'
// mock de './expenses-api' con listExpenses = vi.fn()

const e = (id: string) => ({ id, origin: { kind: 'external', payeeName: 'P' }, concept: id, category: 'C', amount: '1.00', status: 'PENDING', dueDate: null, paidAt: null, notes: null, createdAt: '2026-10-07T00:00:00.000Z' }) as const

it('carga la primera página', async () => {
  listExpenses.mockResolvedValue({ items: [e('a')], nextCursor: 'c1' })
  const { result } = renderHook(() => useExpenseList('ev-1', {}))
  await waitFor(() => expect(result.current.state.status).toBe('ready'))
  expect(result.current.state.items.map((x) => x.id)).toEqual(['a'])
  expect(listExpenses).toHaveBeenCalledWith('ev-1', {}, null)
})

it('loadMore añade la página siguiente', async () => {
  listExpenses.mockResolvedValueOnce({ items: [e('a')], nextCursor: 'c1' }).mockResolvedValueOnce({ items: [e('b')], nextCursor: null })
  const { result } = renderHook(() => useExpenseList('ev-1', {}))
  await waitFor(() => expect(result.current.state.status).toBe('ready'))
  act(() => result.current.loadMore())
  await waitFor(() => expect(result.current.state.items.map((x) => x.id)).toEqual(['a', 'b']))
  expect(listExpenses).toHaveBeenLastCalledWith('ev-1', {}, 'c1')
  expect(result.current.state.nextCursor).toBeNull()
})

it('cambiar filtros mientras loadMore está en vuelo descarta la página vieja', async () => {
  let resolverVieja: (v: unknown) => void = () => {}
  listExpenses
    .mockResolvedValueOnce({ items: [e('a')], nextCursor: 'c1' })
    .mockReturnValueOnce(new Promise((r) => { resolverVieja = r }))
    .mockResolvedValueOnce({ items: [e('p')], nextCursor: null })
  const { result, rerender } = renderHook(({ f }) => useExpenseList('ev-1', f), { initialProps: { f: {} as ExpenseFilters } })
  await waitFor(() => expect(result.current.state.status).toBe('ready'))
  act(() => result.current.loadMore())
  rerender({ f: { status: 'PAID' } })
  await waitFor(() => expect(result.current.state.items.map((x) => x.id)).toEqual(['p']))
  resolverVieja({ items: [e('b')], nextCursor: null })
  await Promise.resolve()
  expect(result.current.state.items.map((x) => x.id)).toEqual(['p'])
})

it('replace sustituye una fila por id', async () => {
  listExpenses.mockResolvedValue({ items: [e('a'), e('b')], nextCursor: null })
  const { result } = renderHook(() => useExpenseList('ev-1', {}))
  await waitFor(() => expect(result.current.state.status).toBe('ready'))
  act(() => result.current.replace({ ...e('b'), status: 'PAID' }))
  expect(result.current.state.items[1]?.status).toBe('PAID')
})

it('error en la primera carga y reload', async () => {
  listExpenses.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce({ items: [], nextCursor: null })
  const { result } = renderHook(() => useExpenseList('ev-1', {}))
  await waitFor(() => expect(result.current.state.status).toBe('error'))
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.state.status).toBe('ready'))
})

it('un fallo de loadMore conserva la lista y marca loadMoreError', async () => {
  listExpenses.mockResolvedValueOnce({ items: [e('a')], nextCursor: 'c1' }).mockRejectedValueOnce(new Error('x'))
  const { result } = renderHook(() => useExpenseList('ev-1', {}))
  await waitFor(() => expect(result.current.state.status).toBe('ready'))
  act(() => result.current.loadMore())
  await waitFor(() => expect(result.current.state.loadMoreError).toBe(true))
  expect(result.current.state.items.map((x) => x.id)).toEqual(['a'])
})
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implementar**

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { listExpenses, type Expense, type ExpenseFilters } from './expenses-api'

/**
 * Lista de gastos paginada por cursor. Cada carga lleva un número de
 * generación: cambiar filtros o recargar sube la generación y cualquier
 * respuesta de una generación anterior (p.ej. un "Load more" que estaba en
 * vuelo) se descarta, para no mezclar páginas de dos consultas distintas.
 * Los filtros se comparan por valor (`status` + `origin`), no por identidad.
 */
export function useExpenseList(eventId: string, filters: ExpenseFilters) {
  const [state, setState] = useState<ExpenseListState>({ status: 'loading', items: [], nextCursor: null, loadingMore: false, loadMoreError: false })
  const generation = useRef(0)
  const [attempt, setAttempt] = useState(0)
  const { status, origin } = filters

  useEffect(() => {
    const gen = ++generation.current
    setState({ status: 'loading', items: [], nextCursor: null, loadingMore: false, loadMoreError: false })
    listExpenses(eventId, { ...(status ? { status } : {}), ...(origin ? { origin } : {}) }, null).then(
      (page) => { if (gen === generation.current) setState({ status: 'ready', items: page.items, nextCursor: page.nextCursor, loadingMore: false, loadMoreError: false }) },
      () => { if (gen === generation.current) setState((s) => ({ ...s, status: 'error' })) },
    )
    return () => { generation.current++ }
  }, [eventId, status, origin, attempt])

  const loadMore = useCallback(() => {
    const cursor = state.nextCursor
    if (cursor === null || state.loadingMore) return
    const gen = generation.current
    setState((s) => ({ ...s, loadingMore: true, loadMoreError: false }))
    listExpenses(eventId, { ...(status ? { status } : {}), ...(origin ? { origin } : {}) }, cursor).then(
      (page) => { if (gen === generation.current) setState((s) => ({ ...s, items: [...s.items, ...page.items], nextCursor: page.nextCursor, loadingMore: false })) },
      () => { if (gen === generation.current) setState((s) => ({ ...s, loadingMore: false, loadMoreError: true })) },
    )
  }, [eventId, status, origin, state.nextCursor, state.loadingMore])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  const replace = useCallback((expense: Expense) => {
    setState((s) => ({ ...s, items: s.items.map((x) => (x.id === expense.id ? expense : x)) }))
  }, [])

  return { state, loadMore, reload, replace }
}
```

Si el lint `react-hooks/set-state-in-effect` rechaza el `setState` dentro del efecto, derivar "loading" como en `features/dashboard/use-load.ts` (guardar la generación/attempt del último resultado y calcular `loading` cuando no coincide); decirlo en el report. El cleanup que sube la generación evita escribir estado tras desmontar.

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/budget/use-expense-list.ts src/features/budget/use-expense-list.test.tsx
git commit -m "feat: lista de gastos paginada con filtros"
```

---

### Task 9: pantalla Budget (tarjetas, lista, panel, lectura/edición, marcar pagado, borrar)

**Files:**
- Rewrite: `src/features/budget/budget-screen.tsx` (+ test), `budget-summary-card.tsx` (+ test), `expense-row.tsx` (+ test)
- Create: `src/features/budget/category-breakdown.tsx` (+ test), `delete-expense-modal.tsx` (+ test)
- Delete: `src/features/budget/mocks.ts`, `mocks.test.ts`, `savings-impact-card.tsx`, `savings-impact-card.test.tsx` (y lo que quede sin uso en `budget-icons.tsx`)

**Interfaces:**
- Consumes: `getEvent` (`budgetAccess`, `event.currency`), `getBudgetSummary` (Task 5), `useExpenseList`, `updateExpense`, `deleteExpense` (Tasks 7–8), `useLoad` de `../dashboard/use-load`, `errorMessage` de `../event-config/errors`, `Select`.
- Produces:
  - `BudgetSummaryCard({ label, value, total, currency, tone, emptyAction }: { label: string; value: string | null; total: string | null; currency: string; tone: StatProgressTone; emptyAction?: ReactNode })` — `value === null` → "Not set" (+ `emptyAction`); progreso `value/total` en 0..100, 0 si no hay total o es 0.
  - `ExpenseRow({ expense, currency, actions }: { expense: Expense; currency: string; actions?: ReactNode })`
  - `CategoryBreakdown({ categories, currency }: { categories: CategoryTotal[]; currency: string })`
  - `DeleteExpenseModal({ expense, onOpenChange, onConfirm }: { expense: Expense | null; onOpenChange: (open: boolean) => void; onConfirm: () => Promise<void> })`
  - `BudgetScreen({ eventId })` con un hueco para el modal de alta/edición que Task 10 enchufa: estado `editing: { mode: 'new' } | { mode: 'edit'; expense: Expense } | null` y botones Add Expense / Edit que lo fijan (en esta tarea el modal aún no existe: no renderizar nada para `editing`).

- [ ] **Step 1: Tests de componentes (fallan)**

`budget-summary-card.test.tsx`:

```tsx
it('formatea en la moneda del evento y deriva el progreso', () => {
  render(<BudgetSummaryCard label="Paid" value="250.00" total="1000.00" currency="EUR" tone="success" />)
  expect(screen.getByText('€250')).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
})

it('sin valor muestra "Not set" y su acción; sin total el progreso es 0 (nunca NaN)', () => {
  render(<BudgetSummaryCard label="Total Budget" value={null} total={null} currency="EUR" tone="primary" emptyAction={<a href="/x">Set a budget</a>} />)
  expect(screen.getByText('Not set')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Set a budget' })).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
})

it('total 0 con pagado da progreso 0', () => {
  render(<BudgetSummaryCard label="Paid" value="10.00" total="0.00" currency="EUR" tone="success" />)
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
})
```

`expense-row.test.tsx` (dentro de `<table><tbody>`):

```tsx
const vendorExpense = { id: 'x', origin: { kind: 'vendor', eventVendorId: 'v', vendorName: 'DJ Max' }, concept: 'Anticipo', category: 'Music', amount: '200.00', status: 'PENDING', dueDate: '2027-05-01', paidAt: null, notes: null, createdAt: '' } as const

it('pinta concepto, categoría, pagador, vencimiento, monto y estado', () => {
  renderRow(<ExpenseRow expense={vendorExpense} currency="USD" />)
  expect(screen.getByText('Anticipo')).toBeInTheDocument()
  expect(screen.getByText('Music')).toBeInTheDocument()
  expect(screen.getByText('DJ Max')).toBeInTheDocument()
  expect(screen.getByText('May 1, 2027')).toBeInTheDocument()
  expect(screen.getByText('$200.00')).toBeInTheDocument()
  expect(screen.getByText('Pending')).toBeInTheDocument()
})

it('externo y sin vencimiento', () => {
  renderRow(<ExpenseRow expense={{ ...vendorExpense, origin: { kind: 'external', payeeName: 'Floristería' }, dueDate: null, status: 'PAID' }} currency="USD" />)
  expect(screen.getByText('External · Floristería')).toBeInTheDocument()
  expect(screen.getByText('—')).toBeInTheDocument()
  expect(screen.getByText('Paid')).toBeInTheDocument()
})

it('las acciones sólo aparecen si se pasan', () => {
  renderRow(<ExpenseRow expense={vendorExpense} currency="USD" />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
```

La fecha de vencimiento (`YYYY-MM-DD`) se formatea con `Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' })` sobre `${dueDate}T00:00:00Z` (es un día, no un instante).

`category-breakdown.test.tsx`:

```tsx
it('una fila por categoría con total y barra pagado/total', () => {
  render(<CategoryBreakdown currency="EUR" categories={[{ category: 'Flowers', paid: '50.00', pending: '150.00', total: '200.00', count: 2 }]} />)
  expect(screen.getByRole('heading', { name: 'By category' })).toBeInTheDocument()
  expect(screen.getByText('Flowers')).toBeInTheDocument()
  expect(screen.getByText('€200')).toBeInTheDocument()
  expect(screen.getByRole('progressbar', { name: 'Flowers: 25% paid' })).toHaveAttribute('aria-valuenow', '25')
})

it('vacío', () => {
  render(<CategoryBreakdown currency="EUR" categories={[]} />)
  expect(screen.getByText('No categories yet')).toBeInTheDocument()
})
```

`delete-expense-modal.test.tsx`:

```tsx
it('confirma y cierra; un fallo se muestra y el modal sigue abierto', async () => {
  const onConfirm = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(undefined)
  const onOpenChange = vi.fn()
  render(<DeleteExpenseModal expense={vendorExpense} onOpenChange={onOpenChange} onConfirm={onConfirm} />)
  expect(screen.getByRole('dialog', { name: 'Delete this expense?' })).toHaveTextContent('Anticipo')
  await userEvent.click(screen.getByRole('button', { name: 'Delete expense' }))
  expect(await screen.findByRole('alert')).toBeInTheDocument()
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
  await userEvent.click(screen.getByRole('button', { name: 'Delete expense' }))
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
})
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implementar componentes**

`BudgetSummaryCard` sobre `StatCard` (formato `Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 })`; `value === null` → `value={<span>Not set</span>}` y `footer={emptyAction}`; `percent = total && Number(total) > 0 && value ? clamp(Number(value)/Number(total)*100) : 0`). Mantener los comentarios útiles del fichero actual.

`ExpenseRow`: celdas Concept (concepto + categoría en `text-xs text-ink/60` debajo), Payee, Due, Amount (`maximumFractionDigits: 2`, alineado a la derecha), Status (`Badge` warning "Pending" / success "Paid"), y `actions` en una última celda alineada a la derecha si se pasan. Docblock: referencia del export y DESIGN-GAP (el export era por categoría; aquí una fila por gasto — decisión confirmada).

`CategoryBreakdown`: `Card` con `<h3>By category</h3>` y una lista; cada fila: nombre, total formateado, `ProgressBar value={paid/total*100}` con `aria-label={`${category}: ${percent}% paid`}` (percent redondeado). Vacío: `EmptyState size="sm"` "No categories yet".

`DeleteExpenseModal`: `Modal open={expense !== null}` + `ModalTitle` "Delete this expense?" + texto con concepto y monto + `Button variant="ghost"` "Cancel" y `Button` "Delete expense" (con `loading`); error con `errorMessage(error, "We couldn't delete the expense. Please try again.")` en `role="alert"`.

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Test de la pantalla (falla)**

Reescribir `budget-screen.test.tsx` (mocks: `../event-config/event-api` → `getEvent`; `../event-config/budget-summary-api` → `getBudgetSummary`; `./expenses-api` → `listExpenses`, `updateExpense`, `deleteExpense`; render dentro de `MemoryRouter`):

```tsx
const summary = { currency: 'USD', totalBudget: '1000.00', assigned: '0.00', unassigned: '1000.00', paid: '200.00', pending: '100.00', remaining: '700.00', byCategory: [{ category: 'Music', paid: '200.00', pending: '0.00', total: '200.00', count: 1 }] }
const owner = { event: { ...event, currency: 'USD' }, isOwner: true, access: 'owner', budgetAccess: 'edit' }

it('el creador ve tarjetas, badge, lista, panel y acciones', async () => {
  getEvent.mockResolvedValue(owner)
  getBudgetSummary.mockResolvedValue(summary)
  listExpenses.mockResolvedValue({ items: [vendorExpense], nextCursor: null })
  renderScreen()
  expect(await screen.findByRole('heading', { name: 'Budget Manager', level: 2 })).toBeInTheDocument()
  expect(await screen.findByText('On Track')).toBeInTheDocument()
  expect(screen.getByText('$700')).toBeInTheDocument()
  expect(await screen.findByText('Anticipo')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Add Expense' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Mark Anticipo as paid' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'By category' })).toBeInTheDocument()
})

it('remaining negativo → Over Budget; sin total → sin badge y "Not set"', async () => { /* dos renders con summary ajustado */ })

it('sólo lectura: sin Add Expense ni acciones', async () => {
  getEvent.mockResolvedValue({ ...owner, isOwner: false, access: 'member', budgetAccess: 'view' })
  getBudgetSummary.mockResolvedValue(summary)
  listExpenses.mockResolvedValue({ items: [vendorExpense], nextCursor: null })
  renderScreen()
  expect(await screen.findByText('Anticipo')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Add Expense' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Mark .* as paid/ })).not.toBeInTheDocument()
})

it('sin acceso al presupuesto es NotFound y no pide nada más', async () => {
  getEvent.mockResolvedValue({ ...owner, isOwner: false, access: 'member', budgetAccess: 'none' })
  renderScreen()
  expect(await screen.findByRole('heading', { name: /not found|can.t find/i })).toBeInTheDocument()
  expect(getBudgetSummary).not.toHaveBeenCalled()
  expect(listExpenses).not.toHaveBeenCalled()
})

it('Mark as paid hace PATCH del estado, sustituye la fila y recarga el resumen', async () => {
  getEvent.mockResolvedValue(owner)
  getBudgetSummary.mockResolvedValue(summary)
  listExpenses.mockResolvedValue({ items: [vendorExpense], nextCursor: null })
  updateExpense.mockResolvedValue({ ...vendorExpense, status: 'PAID' })
  renderScreen()
  await userEvent.click(await screen.findByRole('button', { name: 'Mark Anticipo as paid' }))
  expect(updateExpense).toHaveBeenCalledWith('ev-1', 'x', { status: 'PAID' })
  expect(await screen.findByRole('button', { name: 'Mark Anticipo as pending' })).toBeInTheDocument()
  expect(getBudgetSummary).toHaveBeenCalledTimes(2)
  expect(listExpenses).toHaveBeenCalledTimes(1)
})

it('filtrar por estado recarga desde la primera página', async () => {
  // … seleccionar "Paid" en el Select "Status" → listExpenses llamado con ({ status: 'PAID' }, null)
})

it('Load more pide la página siguiente', async () => {
  // … nextCursor 'c1' → botón "Load more" → listExpenses(..., 'c1')
})

it('borrar confirma, llama a la API y recarga lista y resumen', async () => { /* … */ })

it('lista vacía sin filtros / con filtros', async () => {
  // "No expenses recorded yet." vs "No expenses match these filters."
})

it('un fallo del resumen no tumba la lista', async () => {
  // getBudgetSummary rechaza → "Retry" en las tarjetas; la lista sigue visible
})
```

Completar los cuerpos marcados con `/* … */` siguiendo el patrón de los casos completos (mismos mocks y helpers).

- [ ] **Step 6: Run to verify fail** — FAIL.

- [ ] **Step 7: Implementar la pantalla**

`budget-screen.tsx` ensambla (sin `Sidebar`/`AppTopbar` propios; cabecera de sección dentro de `<main>`, como `event-settings-screen.tsx`):

```tsx
export interface BudgetScreenProps {
  /** Evento de la ruta `/events/:eventId/expenses`. */
  eventId: string
}

export function BudgetScreen({ eventId }: BudgetScreenProps) {
  const loadEvent = useCallback(() => getEvent(eventId), [eventId])
  const eventLoad = useLoad(loadEvent, true)
  const ready = eventLoad.state.kind === 'ready' ? eventLoad.state.data : null
  const access = ready?.budgetAccess ?? 'none'
  const canView = ready !== null && access !== 'none'
  const canEdit = access === 'edit'

  const loadSummary = useCallback(() => getBudgetSummary(eventId), [eventId])
  const summary = useLoad(loadSummary, canView)

  const [statusFilter, setStatusFilter] = useState<'' | ExpenseStatus>('')
  const [originFilter, setOriginFilter] = useState<'' | 'vendor' | 'external'>('')
  const filters = useMemo(() => ({ ...(statusFilter ? { status: statusFilter } : {}), ...(originFilter ? { origin: originFilter } : {}) }), [statusFilter, originFilter])
  const list = useExpenseList(eventId, filters)   // ver nota: no pedir sin canView
  const [deleting, setDeleting] = useState<Expense | null>(null)
  const [editing, setEditing] = useState<EditingState>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  // …
}
```

Nota: `useExpenseList` no debe pedir nada hasta saber que hay acceso. Añadirle un tercer parámetro `enabled: boolean` (default `true`; con `false` queda en `loading` sin llamar) y su test en `use-expense-list.test.tsx` ("deshabilitado no llama"); pasar `canView`.

Estados:
- `eventLoad` error 404 o `ready && access === 'none'` → `<NotFoundScreen inLayout />`; otro error → `Card` "We couldn't load this event." + `Button` "Try Again" (`eventLoad.retry`); cargando → `<p role="status">Loading budget…</p>`.
- Cabecera: `<h2>Budget Manager</h2>`, badge según `summary` listo (`remaining === null` → nada; `Number(remaining) < 0` → `Badge variant="error"` "Over Budget"; si no `Badge variant="success"` "On Track"); `canEdit` → `Button` "Add Expense" (`setEditing({ mode: 'new' })`).
- Tarjetas (grid como el actual): con `summary` listo, cuatro `BudgetSummaryCard` — Total Budget (`value=totalBudget`, `total=totalBudget`, `emptyAction` "Set a budget" a `setup/budget` si `canEdit`), Paid, Pending, Remaining (`value=remaining`); con error, `Card` con "We couldn't load the budget summary." + `Button` "Retry"; cargando, `role="status"`.
- Tabla: `Card` + cabecera "Expenses" con dos `Select` (aria-label "Status": All/Pending/Paid; "Origin": All/Vendors/External) + `Table label="Expenses"` con columnas `['Concept', 'Payee', 'Due', 'Amount', 'Status', ...(canEdit ? ['Actions'] : [])]`; filas `ExpenseRow` con `actions` (sólo `canEdit`): `Button size="sm" variant="ghost" aria-label={`Mark ${concept} as ${status === 'PENDING' ? 'paid' : 'pending'}`}`, `IconButton` "Edit {concept}" (`setEditing({ mode: 'edit', expense })`), `IconButton` "Delete {concept}" (`setDeleting(expense)`). Vacío: `TableEmpty` + `EmptyState` con el texto según haya filtros. Pie: `Button` "Load more" si `nextCursor !== null` (con `loading={loadingMore}`) y aviso `role="alert"` si `loadMoreError`. Error de la primera carga: mensaje + "Retry" (`list.reload`).
- Marcar pagado: `const updated = await updateExpense(eventId, e.id, { status: next }); list.replace(updated); summary.retry()`; error → `setRowError(errorMessage(...))` mostrado en `role="alert"` bajo la tabla.
- Borrar: `DeleteExpenseModal` con `onConfirm = async () => { await deleteExpense(eventId, deleting.id); list.reload(); summary.retry() }`.
- Panel lateral: `CategoryBreakdown` con `summary.byCategory` (si `summary` listo) y la card de "Expense Allocation" actual tal cual (DESIGN-GAP del donut). Quitar la card "Need to export?".
- Docblock: referencia del export, decisiones confirmadas (lista por gasto + panel por categoría; búsqueda, campana, Savings Impact y export retirados por no tener datos/función), y modos `edit`/`view`.

Si la pantalla supera ~250 líneas, extraer la tabla a `expenses-table.tsx` (props: `list`, `canEdit`, `currency`, callbacks) y decirlo en el report.

- [ ] **Step 8: Run to verify pass** — `npx vitest run src/features/budget && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 9: Commit**

```bash
git add -A src/features/budget
git commit -m "feat: vista Budget con resumen, lista de gastos y totales por categoría"
```

---

### Task 10: `ExpenseFormModal` (alta y edición)

**Files:**
- Create: `src/features/budget/expense-form-modal.tsx`, `expense-form-modal.test.tsx`, `src/features/budget/expense-form-schema.ts`
- Modify: `src/features/budget/budget-screen.tsx` (+ test) — enchufar el modal

**Interfaces:**
- Consumes: `createExpense`, `updateExpense`, `Expense`, `NewExpense`, `ExpenseChanges` (Task 7); `listEventVendors`, `EventVendor` (`../event-config/event-api`); `currencySymbol`; `Tabs`, `Select`, `Input`, `Textarea`, `FormField`, `Modal`.
- Produces: `ExpenseFormModal({ open, eventId, currency, categories, expense, onOpenChange, onSaved }: { open: boolean; eventId: string; currency: string; categories: string[]; expense: Expense | null; onOpenChange: (open: boolean) => void; onSaved: () => void })` — `expense === null` = alta.

- [ ] **Step 1: Tests (fallan)**

```tsx
// mocks: './expenses-api' → createExpense, updateExpense; '../event-config/event-api' → listEventVendors
const vendors = [
  { id: 'v-1', name: 'DJ Max', category: { id: 'c', slug: 'c', name: 'Music' }, specialty: null, assignedBudget: null, status: 'BOOKED' },
  { id: 'v-2', name: 'Gone', category: { id: 'c', slug: 'c', name: 'Music' }, specialty: null, assignedBudget: null, status: 'CANCELLED' },
]

function renderModal(props: Partial<Parameters<typeof ExpenseFormModal>[0]> = {}) {
  const onSaved = vi.fn(); const onOpenChange = vi.fn()
  render(<MemoryRouter><ExpenseFormModal open eventId="ev-1" currency="EUR" categories={['Flowers', 'Music']} expense={null} onOpenChange={onOpenChange} onSaved={onSaved} {...props} /></MemoryRouter>)
  return { onSaved, onOpenChange }
}

it('alta con proveedor: manda eventVendorId y cierra', async () => {
  listEventVendors.mockResolvedValue(vendors)
  createExpense.mockResolvedValue({})
  const { onSaved, onOpenChange } = renderModal()
  await userEvent.type(screen.getByLabelText('Concept'), 'Anticipo')
  await userEvent.type(screen.getByLabelText('Category'), 'Music')
  await userEvent.type(screen.getByLabelText('Amount'), '200')
  await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Vendor' }), 'v-1')
  await userEvent.click(screen.getByRole('button', { name: 'Add expense' }))
  expect(createExpense).toHaveBeenCalledWith('ev-1', {
    concept: 'Anticipo', category: 'Music', amount: '200', payee: { kind: 'vendor', eventVendorId: 'v-1' },
    dueDate: null, status: 'PENDING', notes: null,
  })
  expect(onSaved).toHaveBeenCalled()
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it('el selector de proveedor excluye los cancelados', async () => {
  listEventVendors.mockResolvedValue(vendors)
  renderModal()
  const select = await screen.findByRole('combobox', { name: 'Vendor' })
  expect(within(select).queryByRole('option', { name: 'Gone' })).not.toBeInTheDocument()
})

it('alta externa: manda payeeName', async () => {
  listEventVendors.mockResolvedValue([])
  createExpense.mockResolvedValue({})
  renderModal()
  await userEvent.click(screen.getByRole('tab', { name: 'External' }))
  await userEvent.type(screen.getByLabelText('Concept'), 'Ramo')
  await userEvent.type(screen.getByLabelText('Category'), 'Flowers')
  await userEvent.type(screen.getByLabelText('Amount'), '100.50')
  await userEvent.type(screen.getByLabelText('Payee name'), 'Floristería')
  await userEvent.click(screen.getByRole('button', { name: 'Add expense' }))
  expect(createExpense).toHaveBeenCalledWith('ev-1', expect.objectContaining({ payee: { kind: 'external', payeeName: 'Floristería' } }))
})

it('validaciones: obligatorios, monto > 0 con 2 decimales, pagador elegido', async () => {
  listEventVendors.mockResolvedValue(vendors)
  renderModal()
  await userEvent.type(screen.getByLabelText('Amount'), '0')
  await userEvent.click(screen.getByRole('button', { name: 'Add expense' }))
  expect(await screen.findByText('Add a concept.')).toBeInTheDocument()
  expect(screen.getByText('Add a category.')).toBeInTheDocument()
  expect(screen.getByText('Enter an amount greater than 0, like 250 or 250.50.')).toBeInTheDocument()
  expect(screen.getByText('Choose a vendor.')).toBeInTheDocument()
  expect(createExpense).not.toHaveBeenCalled()
})

it('sin proveedores, la pestaña Vendor lo dice y enlaza al paso de presupuesto', async () => {
  listEventVendors.mockResolvedValue([])
  renderModal()
  expect(await screen.findByText('This event has no vendors yet.')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Add vendors' })).toHaveAttribute('href', '/events/ev-1/setup/budget')
})

it('la categoría sugiere las existentes', () => {
  listEventVendors.mockResolvedValue([])
  renderModal()
  const input = screen.getByLabelText('Category')
  const list = document.getElementById(input.getAttribute('list') ?? '')
  expect([...(list?.querySelectorAll('option') ?? [])].map((o) => o.getAttribute('value'))).toEqual(['Flowers', 'Music'])
})

it('edición: rellena, manda sólo lo cambiado y deshabilita Save sin cambios', async () => {
  listEventVendors.mockResolvedValue(vendors)
  updateExpense.mockResolvedValue({})
  renderModal({ expense: { id: 'x', origin: { kind: 'vendor', eventVendorId: 'v-1', vendorName: 'DJ Max' }, concept: 'Anticipo', category: 'Music', amount: '200.00', status: 'PENDING', dueDate: null, paidAt: null, notes: null, createdAt: '' } })
  const save = screen.getByRole('button', { name: 'Save changes' })
  expect(save).toBeDisabled()
  await userEvent.clear(screen.getByLabelText('Amount'))
  await userEvent.type(screen.getByLabelText('Amount'), '250')
  await userEvent.click(save)
  expect(updateExpense).toHaveBeenCalledWith('ev-1', 'x', { amount: '250' })
})

it('edición: cambiar a externo manda sólo el pagador nuevo', async () => {
  // … pestaña External + "Payee name" → updateExpense('ev-1','x',{ payee: { kind: 'external', payeeName: 'Otra' } })
})

it('error de la API se muestra y no pierde lo tecleado; 404 de proveedor tiene su mensaje', async () => {
  listEventVendors.mockResolvedValue(vendors)
  createExpense.mockRejectedValue(new ApiRequestError(404, { code: 'EVENT_VENDOR_NOT_FOUND', message: 'x' }))
  renderModal()
  // … rellenar con proveedor v-1 y enviar
  expect(await screen.findByRole('alert')).toHaveTextContent('That vendor is no longer part of this event.')
  expect(screen.getByLabelText('Concept')).toHaveValue('Anticipo')
})
```

Leer en el backend (`src/modules/expenses/domain/expense-errors.ts` o `src/modules/vendors/domain/vendor-errors.ts`) el `code` real del error 404 `ProveedorDelEventoNoEncontradoError` y usarlo en el test y en el mapeo.

En `budget-screen.test.tsx` añadir: Add Expense abre el modal ("Add expense" dialog); Edit {concept} lo abre en modo edición; tras `onSaved` se recargan lista (primera página) y resumen.

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implementar**

`expense-form-schema.ts`:

```ts
import { z } from 'zod'

/** Formulario de gasto. El pagador va por estado propio (pestañas), no por aquí. */
export const expenseFormSchema = z.object({
  concept: z.string().trim().min(1, 'Add a concept.').max(200),
  category: z.string().trim().min(1, 'Add a category.').max(100),
  amount: z
    .string()
    .trim()
    .refine((v) => /^\d+(\.\d{1,2})?$/.test(v) && Number(v) > 0, { message: 'Enter an amount greater than 0, like 250 or 250.50.' }),
  dueDate: z.string().refine((v) => v === '' || z.iso.date().safeParse(v).success, { message: 'Enter a valid date.' }),
  status: z.enum(['PENDING', 'PAID']),
  notes: z.string().trim().max(2000),
})
export type ExpenseFormValues = z.output<typeof expenseFormSchema>
```

`expense-form-modal.tsx`:
- `Modal open` + `ModalContent` + `ModalTitle` ("Add expense" / "Edit expense") + `ModalDescription` visualmente oculta (como `schedule-item-modal.tsx`).
- Formulario con `useValidatedForm(expenseFormSchema, initial, onValid)`; `initial` desde `expense` (amount `"200.00"` → se muestra tal cual; dueDate `''` si null; notes `''` si null) o vacíos con `status: 'PENDING'`. Montar el formulario con `key={expense?.id ?? 'new'}` para que cada apertura empiece limpia.
- Category: `Input` con `list={`${id}-categories`}` + `<datalist id=…>` con `categories`.
- Amount: `Input inputMode="decimal"` con `leading={currencySymbol(currency)}`.
- Status: `Select` (Pending/Paid). Due date: `Input type="date"`. Notes: `Textarea`.
- Pagador: `Tabs value={payeeTab}` con `TabsTrigger` "Vendor"/"External". Vendor: `Select aria-label="Vendor"` con los `listEventVendors` no `CANCELLED` (cargados al abrir, con estado de carga/error y "Retry"); sin proveedores: texto "This event has no vendors yet." + `Link` "Add vendors" a `/events/:id/setup/budget`. External: `FormField` "Payee name". Errores propios: "Choose a vendor." / "Add the payee's name." (estado local, comprobado al enviar).
- Envío: alta → `createExpense(eventId, { concept, category, amount, payee, dueDate: dueDate || null, status, notes: notes || null })`. Edición → construir `changes` comparando con `expense` (sólo claves distintas; `amount` se compara numéricamente con el original para que "200" y "200.00" no cuenten como cambio; `payee` sólo si cambió el tipo o el id/nombre) y `updateExpense(eventId, expense.id, changes)`. Botón "Save changes" deshabilitado si no hay cambios.
- Éxito: `onSaved()` y `onOpenChange(false)`. Error: `role="alert"` con el mensaje del 404 de proveedor o `errorMessage(error, "We couldn't save the expense. Please try again.")`; los valores se conservan.
- El modal va fuera de cualquier `<form>` ajeno (la pantalla no tiene uno).

En `budget-screen.tsx`: `<ExpenseFormModal open={editing !== null} eventId={eventId} currency={currency} categories={summaryCategories} expense={editing?.mode === 'edit' ? editing.expense : null} onOpenChange={(o) => { if (!o) setEditing(null) }} onSaved={() => { list.reload(); summary.retry() }} />`, con `summaryCategories = summary listo ? summary.byCategory.map((c) => c.category) : []`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/features/budget && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/features/budget
git commit -m "feat: alta y edición de gastos"
```

---

### Task 11: gates finales

**Files:** los que señalen los gates.

- [ ] **Step 1:** Backend: tests unit + e2e completos, typecheck, lint. Frontend: `npm test && npm run typecheck && npm run lint`. Corregir lo que salga (tokens muertos por los mocks borrados del budget, imports sin uso).
- [ ] **Step 2:** `grep -rn "budget/mocks\|savings-impact" src` en el frontend → sin resultados. Actualizar el docblock de `router.tsx` y `app-layout.tsx` con la ruta y el ítem Budget si no se hizo. `CLAUDE.md` del frontend está en `.gitignore`: actualizarlo sólo en local (ruta nueva).
- [ ] **Step 3:** Commit de lo que haya cambiado (si algo):

```bash
git add -A src
git commit -m "chore: limpieza final de la vista Budget"
```

- [ ] **Step 4:** Prueba manual (backend + DB locales) — la hace el usuario: como creadora, añadir gastos de proveedor y externos, marcar pagado, filtrar, Load more con >25 gastos, ver el panel por categoría; como miembro COUPLE no creador (membresía creada a mano), comprobar que no aparece Budget, que el dashboard no muestra la tarjeta y que el total y lo asignado salen vacíos.
