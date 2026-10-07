# Vista Budget: gastos, resumen por categoría y visibilidad del presupuesto

> Diseño aprobado en conversación el 2026-10-07. Ramas `feat/presupuesto` desde
> `develop` en `wedding-planner-backend` y `wedding-planner-frontend`, PR contra
> `develop` (primero el backend). Es la entrega 1 de 2: la entrega 2 (miembros y
> permiso individual de presupuesto) tiene su propio spec.

## 1. Problema

El backend de gastos está completo (`events/:eventId/expenses` y
`budget-summary`), pero el frontend sólo usa el resumen en la tarjeta del
dashboard. `features/budget/budget-screen.tsx` es una maqueta con mocks y sin
ruta: no hay dónde registrar lo que se paga, así que "Paid to date" siempre es 0.

Además, hoy cualquier miembro COUPLE/PLANNER ve las cifras del evento. El
usuario quiere que el presupuesto sea privado del creador salvo que él lo
comparta, persona a persona.

## 2. Decisiones del usuario

- **Tabla principal = lista de gastos** (una fila por gasto) **y** panel lateral
  con los totales por categoría.
- **Totales por categoría en el backend:** `budget-summary` gana `byCategory`,
  agregado en la base de datos (exacto con paginación y filtros).
- **Visibilidad:** sólo el creador ve el presupuesto. Puede concederlo a cada
  miembro (COUPLE o PLANNER) individualmente, con dos niveles: **Ninguno / Ver**.
  Por defecto, **Ninguno**. Editar gastos es siempre sólo del creador.
- **Alcance de "presupuesto":** todo lo económico — gastos, `budget-summary`,
  `totalBudget` del evento y `assignedBudget` de los proveedores. Lo oculta la
  API, no sólo la UI.
- **Dos entregas:** esta (vista Budget + regla de visibilidad, con "Ver" sin
  forma de concederse todavía) y la siguiente (lista de miembros + interruptor
  por persona en Settings y en un modal desde Budget).
- **Invitar y aceptar invitaciones:** fuera de ambas entregas.

Fuera de alcance: lista de miembros, conceder "Ver", invitar/aceptar, búsqueda
de gastos (la API no tiene `q`), exportar a PDF, donut de "Expense Allocation",
"Savings Impact".

## 3. Backend

### 3.1 `byCategory` en `budget-summary`

`GET /events/:eventId/budget-summary` añade:

```ts
byCategory: {
  category: string
  paid: string     // Σ amount PAID
  pending: string  // Σ amount PENDING
  total: string    // paid + pending
  count: number    // nº de gastos
}[]
```

- Puerto `ExpenseRepository.sumasPorCategoria(eventId)` → filas
  `{ category, status, amount, count }`; adaptador Prisma con
  `expense.groupBy({ by: ['category', 'status'], where: { eventId }, _sum: { amount: true }, _count: { _all: true } })`;
  fake equivalente y caso en el test de paridad.
- El dominio (`calcularResumen` recibe las filas) pliega a una fila por
  categoría con aritmética en céntimos (`aCentimos`/`deCentimos`) y ordena por
  `total` desc y luego `category` asc.
- La clave es el texto exacto guardado (el DTO ya hace `trim`). Sin
  normalización de mayúsculas: el frontend sugiere las categorías existentes
  para evitar duplicados.
- Sin gastos → `byCategory: []`.

### 3.2 Visibilidad del presupuesto

Dominio (`events/domain`):

```ts
export type BudgetAccess = 'none' | 'view' | 'edit'
export function accesoAlPresupuesto(acceso: EventAccess): BudgetAccess
// admin → 'edit'; member owner → 'edit'; resto → 'none'
// (la entrega 2 añade 'view' para miembros con el permiso concedido)
```

Rutas:

| Ruta | Antes | Ahora |
|---|---|---|
| `GET expenses`, `GET budget-summary` | COUPLE, PLANNER | `budgetAccess !== 'none'` |
| `POST/PATCH/DELETE expenses` | COUPLE, PLANNER | `budgetAccess === 'edit'` |

Quien no tiene acceso al evento recibe **404** del guard, como siempre. Quien
sí está en el evento pero no tiene el permiso de presupuesto recibe **403**,
igual que las rutas `OWNER` (el guard ya sabe que tiene acceso, así que no
revela nada nuevo). Se implementa con un permiso nuevo en
`@RequireEventAccess` (`'BUDGET_VIEW'`, `'BUDGET_EDIT'`) que `permisosDe`
deriva de `accesoAlPresupuesto`, para no duplicar la regla en cada método.

Ocultar cifras (sin acceso, `null`):

- `GET /events` y `GET /events/:id`: `totalBudget: null`.
- `GET /events/:id/vendors`: `assignedBudget: null` en cada proveedor.
- `GET /events/:id` añade `budgetAccess: BudgetAccess` para que el frontend
  distinga "sin presupuesto" de "oculto".
- `completitud` no se toca: es estado del asistente del creador y no revela
  importes.

`GET /events` no trae `access` por evento: el filtrado de `totalBudget` se
resuelve por evento con la misma función (el listado ya conoce el `ownerId` y
el usuario).

Efecto sobre lo existente: un COUPLE/PLANNER no creador deja de ver gastos,
resumen, total y asignaciones. El asistente y Settings ya son sólo del creador.

## 4. Frontend

### 4.1 Ruta y menú

- `/events/:eventId/expenses` dentro de `RequireAuth` → `AppLayout`
  (`ExpensesRoute`, mismo patrón que `DashboardRoute`, `key={eventId}`).
- `getEvent` lee `budgetAccess` (`'none' | 'view' | 'edit'`) del evento.
- Menú del evento: ítem **Budget** entre Seating Chart y Event setup, sólo si
  `budgetAccess !== 'none'`. `AppLayout` ya pide `getEvent(eventId)` para el
  owner: se amplía para devolver también el acceso al presupuesto.
- La tarjeta Budget Overview del dashboard sólo se pinta (y sólo se pide
  `budget-summary`) si `budgetAccess !== 'none'`, y enlaza a `expenses`.
- El paso Budget del asistente enlaza a `expenses` ("Record expenses").

### 4.2 Pantalla (`features/budget/budget-screen.tsx`)

Sin Sidebar propio (lo pone `AppLayout`); la pantalla sólo ensambla.

- Carga: `getEvent` primero. 404 o `budgetAccess === 'none'` →
  `NotFoundScreen inLayout`. Luego, en paralelo y con estado propio cada uno,
  `budget-summary` y la primera página de gastos.
- **Cabecera:** "Budget Manager" + `Badge` "On Track" (`remaining ≥ 0`) /
  "Over Budget" (`remaining < 0`) / sin badge (sin total). **Add Expense** sólo
  con `edit`. Se quitan la búsqueda y la campana del export (DESIGN-GAP).
- **Tarjetas** (`BudgetSummaryCard`, moneda del evento): Total Budget, Paid,
  Pending, Remaining. "Savings Impact" se sustituye por Remaining
  (DESIGN-GAP: sin datos). Sin total: Total y Remaining muestran "Not set" y,
  con `edit`, enlace a `setup/budget`. Progreso de cada tarjeta respecto al
  total (0 sin total).
- **Tabla "Expenses"** (`ExpenseRow` reescrita para un gasto): Concept (con la
  categoría debajo), Payee (nombre del proveedor o "External · {payee}"), Due
  (fecha corta o "—"), Amount, Status (`Badge` Pending warning / Paid success).
  Con `edit`, acciones por fila: "Mark as paid"/"Mark as pending", Edit,
  Delete. Con `view`, sin columna de acciones.
- **Filtros** (`Select`): Status (All/Pending/Paid) y Origin
  (All/Vendors/External). Cambiar un filtro recarga desde la primera página.
- **Paginación:** "Load more" con `nextCursor` (la API no tiene páginas
  numeradas). Límite 25.
- **Vacío:** `EmptyState` "No expenses recorded yet." (+ Add Expense con `edit`).
  Con filtros activos: "No expenses match these filters."
- **Panel "By category":** una fila por `byCategory` con nombre, total y
  `ProgressBar` de pagado/total; vacío → "No categories yet". La card del donut
  queda como DESIGN-GAP; la de "Need to export?" se quita (no hay export).
- **Tras cada cambio:** alta, edición y borrado → recarga del resumen y de la
  lista desde la primera página con los filtros activos. Mark as paid/pending →
  `PATCH { status }`, sustituye la fila y recarga sólo el resumen.
- Errores de cada bloque: mensaje + "Retry" en ese bloque; errores de una
  acción de fila: `role="alert"` bajo la tabla con `errorMessage`.

### 4.3 `ExpenseFormModal` (alta y edición)

- Campos: Concept*, Category* (`Input` con `<datalist>` de las categorías de
  `byCategory`), Amount* (> 0, máx. 2 decimales, símbolo de la moneda), Due
  date (opcional), Status (Pending/Paid, por defecto Pending), Notes
  (opcional, máx. 2000).
- Pagador con `Tabs`: **Vendor** (`Select` de los proveedores del evento no
  `CANCELLED`; sin proveedores: mensaje + enlace a `setup/budget`) o
  **External** (nombre, obligatorio en esa pestaña). Se manda exactamente uno:
  `eventVendorId` o `payeeName`.
- Edición: `PATCH` sólo con los campos cambiados; cambiar de pagador manda sólo
  el campo nuevo. Sin cambios → el botón queda deshabilitado.
- Errores de la API dentro del modal sin perder lo tecleado; 404 de
  `ProveedorDelEventoNoEncontrado` → "That vendor is no longer part of this event."
- Borrar: `Modal` de confirmación "Delete this expense?" → `DELETE`.

### 4.4 API

- `features/budget/expenses-api.ts`: `listExpenses(eventId, { status?, origin?, cursor? })`
  → `{ items, nextCursor }`, `createExpense`, `updateExpense`, `deleteExpense`,
  con esquemas zod (respuesta: `id, origin {kind:'vendor', eventVendorId,
  vendorName} | {kind:'external', payeeName}, concept, category, amount,
  status, dueDate, paidAt, notes, createdAt`).
- `getBudgetSummary` sale de `features/dashboard/dashboard-api.ts` a
  `features/event-config/budget-summary-api.ts` con `byCategory`; el dashboard
  lo importa de ahí.
- `event-model`: `budgetAccess` en el evento; `assignedBudget`/`totalBudget`
  ya son nullable.

## 5. Tests

Backend:
- Dominio: plegado de `byCategory` (céntimos, orden, vacío);
  `accesoAlPresupuesto` por cada forma de `EventAccess`.
- Repositorio: `sumasPorCategoria` en la paridad fake/Prisma.
- e2e/controlador: owner ve importes; miembro no creador recibe `totalBudget`
  y `assignedBudget` a `null`, 403 en `GET expenses`/`budget-summary` y en las
  escrituras; vendor igual; `budgetAccess` en `GET /events/:id`.

Frontend:
- `expenses-api` y `budget-summary-api` (validación y query string).
- Pantalla con `edit`: tarjetas, badge, lista, filtros, Load more, Mark as
  paid, alta, edición, borrado, errores por bloque. Con `view`: sin acciones ni
  Add Expense. Con `none`: NotFound.
- Modal: exactamente un pagador, PATCH sólo con cambios, validaciones, errores.
- `AppLayout`: ítem Budget según `budgetAccess`. Dashboard: tarjeta Budget
  oculta y sin petición con `none`.
