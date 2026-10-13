# Miembros del evento: invitar, aceptar, gestionar y compartir el presupuesto

> Diseño aprobado en conversación el 2026-10-13. Ramas `feat/miembros-presupuesto`
> desde `develop` en `wedding-planner-backend` y `wedding-planner-frontend`, PR
> contra `develop` (primero el backend). Es la entrega 2 de 2 de
> `2026-10-07-presupuesto-design.md`, que dejó `BudgetAccess = 'view'` en el
> tipo sin forma de concederse.

## 1. Problema

- Nada pasa una `EventMembership` de INVITED a ACTIVE: `POST /events/:eventId/members`
  crea la invitación, pero el invitado nunca entra al evento.
- No hay endpoint para listar miembros ni UI de miembros.
- El correo `event-invitation` se encola pero **ningún worker lo consume** y no
  existe su plantilla (ver `guests/application/send-invitations.use-case.ts`):
  hoy el invitado no recibe nada.
- El presupuesto es privado del creador y el nivel `view` existe en
  `BudgetAccess`, pero nadie puede recibirlo.

## 2. Decisiones del usuario

- Niveles de presupuesto por miembro: **Ninguno / Ver**. Editar gastos sigue
  siendo sólo del creador. Por defecto **Ninguno**, para miembros existentes y
  nuevos. Lo concede el creador **a cada miembro individualmente** (COUPLE o
  PLANNER).
- "Presupuesto" = todo lo económico: gastos, `budget-summary`, `totalBudget` del
  evento y `assignedBudget` de los proveedores, ocultado por la API.
- Se gestiona en **dos sitios**: sección "Members" en Event Settings y botón
  "Share" en la vista Budget que abre un modal con los mismos miembros e
  interruptores.
- Se incluye **invitar** desde la UI (email + rol) y **aceptar** la invitación.
- **Aceptar en la app**, sin token: el invitado ve sus invitaciones pendientes en
  el selector de eventos (y en el dashboard) y pulsa Accept/Decline. El correo
  se envía (worker + plantilla nuevos) como aviso con enlace a la app.
- **Sólo el creador invita** (`OWNER`, antes cualquier `COUPLE`).
- El creador puede **revocar** miembros, **cancelar** invitaciones pendientes y
  **cambiar el rol**.
- El permiso se guarda en una **tabla aparte** (`EventBudgetGrant`), no como
  columna de `EventMembership`.
- Un miembro con "Ver" ve **lo mismo que el creador, en sólo lectura**: tarjeta
  de presupuesto del dashboard, vista Budget y `assignedBudget` de proveedores.

Fuera de alcance: enlace con token en el correo (y por tanto el DESIGN-GAP del
`jobId` de 24 h sigue abierto), invitar a quien no tiene cuenta
(`InvitadoSinCuentaError` se mantiene), aviso en tiempo real de cambios de
permiso (el miembro lo ve al recargar o al volver a pedir el evento), un nivel
`edit` para miembros.

## 3. Backend

Todo vive en el módulo `events`, que ya es dueño de `EventMembership` y de la
autorización. Un módulo `members` aparte tendría que pedir a `events` cada
decisión de acceso y duplicaría el repositorio de membresías.

### 3.1 Datos (una migración)

```prisma
/// Permiso de VER el presupuesto concedido por el creador a un miembro.
/// Existir = VIEW; no existir = NONE. Editar es siempre del creador.
model EventBudgetGrant {
  id           String   @id @default(uuid()) @db.Uuid
  membershipId String   @unique @db.Uuid
  grantedById  String   @db.Uuid
  createdAt    DateTime @default(now())

  membership EventMembership @relation(fields: [membershipId], references: [id], onDelete: Cascade)

  @@map("event_budget_grants")
}
```

`EventMembership` gana la relación inversa `budgetGrant EventBudgetGrant?`.
No hace falta rellenar nada: sin filas, todos los miembros existentes quedan en
NONE.

Reglas que **no** puede expresar la base y valida el caso de uso (documentarlas
en `docs/DATABASE.md`, en la sección de lo que valida el caso de uso):

- No se concede a la membresía del creador (un CHECK no puede mirar
  `events.ownerId`): 422.
- No se concede a una membresía REVOKED: 422.

Ciclo de vida:

- **Rechazar** una invitación = INVITED → REVOKED. No se añade `DECLINED` al
  enum: Members sólo muestra INVITED y ACTIVE, y REVOKED ya admite reinvitar.
  El `AuditLog` distingue el motivo (`member.declined` / `member.revoked`).
  Coste aceptado: el creador no ve quién rechazó.
- **Revocar o cancelar** = → REVOKED y se **borra el permiso** en la misma
  transacción, así que reinvitar vuelve a NONE (por defecto para "nuevos").
- **Cambiar el rol** conserva el permiso.

### 3.2 Dominio

- `EventAccess` de miembro gana `budgetView: boolean`:
  `{ kind: 'member'; role; owner; budgetView }`. `buscarMembresiaActiva` lo lee
  en la MISMA consulta (`include` del permiso): resolver el acceso sigue
  costando una consulta por fuente.
- `accesoAlPresupuesto`: admin → `edit`; miembro creador → `edit`; miembro con
  `budgetView` → `view`; resto → `none`. `permisosDe` no cambia (ya deriva
  `BUDGET_VIEW` de `view`).
- `accesoAlPresupuestoEnListado(ownerId, userId, budgetView)`:
  `listarAccesiblesPor` incluye la membresía ACTIVE del usuario con su permiso y
  el `Event` de dominio no cambia; el repositorio devuelve el `budgetView` junto
  a cada evento. Las dos funciones delegan en una sola regla privada
  (`reglaPresupuesto({ admin, owner, budgetView })`) para que no deriven, y un
  test recorre todas las combinaciones comparándolas.
- `domain/membresia.ts`: transiciones puras sobre `{ status, owner }` que
  lanzan `DomainError`:
  - `aceptar` / `rechazar`: sólo desde INVITED (si no, `NotFoundError` "no hay
    invitación pendiente", para no revelar el estado ajeno).
  - `revocar`: desde INVITED o ACTIVE; nunca al creador (422).
  - `cambiarRol`: INVITED o ACTIVE; nunca al creador (422).
  - `concederPresupuesto` / `retirarPresupuesto`: INVITED o ACTIVE; nunca al
    creador (422).

### 3.3 Puerto `EventRepository` (métodos nuevos)

- `buscarMembresiaActiva` devuelve además `budgetView`.
- `listarAccesiblesPor` devuelve `{ evento, budgetView }[]`.
- `listarMiembros(eventId)`: INVITED y ACTIVE, con `id`, `userId`, `fullName`,
  `email`, `role`, `status`, `owner`, `budgetView`, `createdAt`. Orden: creador
  primero, luego `createdAt` asc, `id` desc de desempate.
- `buscarMembresiaPorId(eventId, membershipId)`: cualquier estado, con `owner`.
- `actualizarMembresia(membershipId, { role?, budgetView? }, actorId)`: escribe
  rol y crea/borra el grant + `AuditLog`, en una transacción.
- `revocarMembresia(membershipId, actorId, motivo: 'revoked' | 'declined')`:
  → REVOKED, borra el grant, `AuditLog`.
- `aceptarInvitacion(membershipId, userId)`: INVITED → ACTIVE + `AuditLog`.
- `listarInvitacionesPendientes(userId)`: INVITED del usuario con `eventId`,
  `eventName`, `role`, `invitedByName`, `createdAt`.

Las escrituras usan `UnidadDeTrabajo` y bloquean la fila del evento
(`SELECT … FOR UPDATE`) antes de releer la membresía, como el resto de
invariantes que cruzan tablas. El nombre y el email del miembro salen del join
con `users` en la consulta de Prisma, no del `UserRepository` (sería N+1).

### 3.4 API

| Ruta | Guard | Respuesta |
|---|---|---|
| `GET /events/:eventId/members` | `OWNER` | `{ items: Member[] }` |
| `POST /events/:eventId/members` | **`OWNER`** (antes `COUPLE`) | como hoy |
| `PATCH /events/:eventId/members/:membershipId` | `OWNER` | `Member` |
| `DELETE /events/:eventId/members/:membershipId` | `OWNER` | 204 |
| `GET /me/invitations` | autenticado | `{ items: Invitation[] }` |
| `POST /events/:eventId/invitation/accept` | autenticado, sin `RequireEventAccess` | `{ eventId, status: 'ACTIVE' }` |
| `POST /events/:eventId/invitation/decline` | autenticado, sin `RequireEventAccess` | 204 |

- `Member = { id, userId, fullName, email, role, status, owner, budgetAccess: 'none' | 'view' | 'edit', invitedAt }`
  (`edit` sólo en la fila del creador).
- `PATCH` body (Zod, `validarCon`): `{ role?: 'COUPLE' | 'PLANNER', budgetAccess?: 'none' | 'view' }`,
  al menos uno de los dos.
- Accept/decline no pueden pasar por `EventAccessGuard`: una INVITED da acceso
  `none`. Buscan la INVITED del usuario autenticado; si no la hay, 404 (no se
  distingue "no existe el evento" de "no te invitaron").
- `:membershipId` de otro evento → 404.
- Límite de ritmo: el `global`; no se añade limitador con nombre.

### 3.5 Correo

- Worker `events/interfaces/member-invitation.processor.ts` para el trabajo
  `event-invitation` de la cola `email`, siguiendo
  `guests/interfaces/invitation.processor.ts`.
- Plantilla React Email `mail/infrastructure/templates/member-invitation.tsx` y
  puerto `MEMBER_INVITATION_RENDERER` en `mail/application/`, cableado en
  `mail.module.ts`: ningún worker importa el `infrastructure/` de mail.
- Contenido: quién invita, nombre del evento, rol y botón a
  `${APP_URL}/events` ("Log in to accept"). Sin token.
- El payload encolado ya lleva `eventName`, `email`, `fullName` y `role`; se
  añade `invitedByName`.

## 4. Frontend

Carpeta nueva `src/features/members/`, con primitivas existentes (`Modal`,
`Table`, `Select`, `CheckboxSwitch`, `Badge`, `Banner`, `Avatar`).

### 4.1 Piezas compartidas

- `members-api.ts`: `listMembers`, `inviteMember`, `updateMember`,
  `revokeMember`, `listMyInvitations`, `acceptInvitation`, `declineInvitation`,
  con el patrón y el mapeo de errores de `event-config/event-api.ts`.
- `use-members.ts`: carga + mutaciones optimistas del interruptor y del rol;
  si la petición falla, revierte y muestra un toast.
- `MembersList` (`variant: 'full' | 'budget'`): por fila avatar, nombre, email,
  `Select` de rol, `CheckboxSwitch` "Can view budget", `Badge` "Pending" si
  INVITED y revocar/cancelar con confirmación. El creador es una fila fija
  ("Owner", interruptor encendido y deshabilitado). `variant="budget"` sólo
  muestra nombre e interruptor.
- `InviteMemberForm`: email + rol (COUPLE/PLANNER). Errores:
  `InvitadoSinCuentaError` → "This person needs an account first";
  ya miembro → "Already a member of this event".

### 4.2 Dónde se gestiona

- **Event Settings** (`settings/event-settings-screen.tsx`, ya sólo del
  creador): sección "Members" debajo de General Info con `InviteMemberForm` +
  `MembersList variant="full"`.
- **Budget** (`budget/budget-screen.tsx`): botón "Share" en la cabecera junto a
  "Budget Manager", sólo con `budgetAccess === 'edit'`. Abre
  `ShareBudgetModal` con `MembersList variant="budget"` y un enlace "Manage
  members" a Settings.

### 4.3 Aceptar invitaciones

- `use-my-invitations.ts` pide `GET /me/invitations` al montar el layout.
- `app/event-switcher.tsx`: bloque "Invitations" encima de los eventos, con
  nombre del evento, rol, quién invita y botones Accept / Decline.
- Dashboard: `Banner` si hay invitaciones pendientes y el usuario no tiene
  eventos.
- Accept → refresca la lista de eventos y navega al dashboard del evento.
  Decline → la invitación desaparece.

### 4.4 Modo "Ver"

- Vista Budget: el modo de sólo lectura ya existe (`budgetAccess === 'view'`).
- Revisar `dashboard/dashboard-screen.tsx`, `event-vendors/event-vendors-screen.tsx`
  y `event-vendors/my-vendors-tab.tsx`: con `view` se muestran las cifras y no
  las acciones (separar `view` de `edit` allí donde hoy sólo se distingue
  `none`).
- El menú lateral muestra Budget con `view` o `edit`.

## 5. Tests

### 5.1 Backend

- **Dominio**: `membresia.test.ts` (cada transición válida e inválida);
  `event-access.test.ts` amplía `accesoAlPresupuesto` y `permisosDe` con
  `budgetView`, y comprueba que la regla del listado y la del evento coinciden
  en todas las combinaciones.
- **Unitarios** de cada caso de uso nuevo contra `event.repository.fake.ts`, y
  el cambio de guard de invitar.
- **Paridad** (`event.repository.paridad.test.ts`): `budgetView` en
  `buscarMembresiaActiva` y en `listarAccesiblesPor`; `listarMiembros` (orden y
  campos); revocar borra el grant; reinvitar vuelve a NONE; cambiar el rol
  conserva el grant; aceptar; invitaciones pendientes.
- **Integración**: cascada al borrar la membresía; `AuditLog` en la misma
  transacción.
- **E2E `members.e2e.test.ts`**: invitar → aparece en `/me/invitations` →
  aceptar → `GET /events/:id` 200; rechazar; revocar (pierde el acceso);
  cancelar invitación; cambiar rol; sólo el creador gestiona (COUPLE no creador,
  PLANNER y extraño → 403 en las rutas `OWNER`); accept/decline sin invitación
  → 404.
- **E2E matriz de acceso** (amplía `budget-visibility.e2e.test.ts`): creador,
  COUPLE no creador con y sin permiso, PLANNER con y sin permiso, proveedor y
  extraño, contra `GET /events/:id`, `GET /events`, gastos (leer y escribir),
  `budget-summary` y `assignedBudget` de proveedores. Con "Ver" leer da 200 y
  escribir 403.
- **Correo**: processor con `FakeMailAdapter` y test de la plantilla, como los
  de `guest-invitation`.
- **Arquitectura**: sin reglas nuevas; `npm run lint` en verde.

### 5.2 Frontend

- Sección Members (listar, invitar y sus errores, cambiar rol, interruptor con
  reversión si falla, revocar, fila del creador bloqueada).
- Modal Share (sólo con `edit`; el interruptor llama a la API).
- Aceptar/rechazar desde el switcher y banner del dashboard.
- Modo de lectura en Budget, dashboard y proveedores con `view`.
