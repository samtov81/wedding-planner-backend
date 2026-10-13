# Miembros del evento y permiso de ver el presupuesto — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un invitado pueda aceptar y entrar al evento, que el creador gestione los miembros (invitar, cambiar rol, revocar) y conceda a cada uno, individualmente, permiso de VER el presupuesto.

**Architecture:** Backend primero, todo en el módulo `events`: una tabla `event_budget_grants` (existir = VIEW) que `buscarMembresiaActiva` y `listarAccesiblesPor` leen en la misma consulta; `EventAccess` de miembro gana `budgetView` y una única regla de dominio decide `none | view | edit`; transiciones puras de membresía en `domain/membresia.ts`; casos de uso nuevos detrás de rutas `OWNER` y de dos rutas sin guard de evento para aceptar/rechazar; el correo de invitación pasa a una cola propia con worker y plantilla. Frontend después: `features/members/` con API, `MembersList` compartida por Settings y el modal Share de Budget, y un store de invitaciones que alimenta el selector de eventos y la redirección de `/dashboard`.

**Tech Stack:** Backend NestJS 11 + Prisma 6/Postgres 16 + BullMQ + React Email + zod + Vitest (+ Testcontainers). Frontend React 19, react-router 8, zustand 5, zod 4, Vitest + Testing Library.

**Spec:** `wedding-planner-backend/docs/superpowers/specs/2026-10-13-miembros-presupuesto-design.md`

## Global Constraints

- Rama `feat/miembros-presupuesto` desde `develop` en los dos repos (la del backend ya existe; la del frontend se crea en la Task 10). PR contra `develop`, primero el backend.
- Backend: capas del repo (caso de uso con `ejecutar`, puerto = `interface` + `Symbol` en `application/`, adaptador Prisma, doble `*.fake.ts` con test de paridad). `DomainError` lleva su `httpStatus`. Validación con `validarCon(schema, body)`. Nadie lee `process.env` fuera de `src/config`.
- Backend gates (todos en verde antes de cada commit que toque código): `npx vitest run <ficheros>`; al final de cada tarea `npm run typecheck && npm run lint && npx prettier --check .`. Los tests de integración/paridad/e2e necesitan Docker.
- Si cambia `prisma/schema.prisma`, va con su migración en el MISMO commit (CI corre `prisma migrate diff` y falla si no).
- TypeScript estricto: `exactOptionalPropertyTypes` (una prop opcional que acepte `undefined` se escribe `?: X | undefined`), `noUncheckedIndexedAccess`.
- Comentarios, docblocks y nombres de `describe`/`it` en español; strings de API y textos de UI en inglés. Prettier: sin punto y coma, comillas simples, ancho 100. No borrar comentarios `DESIGN-GAP`.
- Niveles: `BudgetAccess = 'none' | 'view' | 'edit'`. Admin y creador → `edit`; miembro con grant → `view`; resto (incluido vendor) → `none`. Editar gastos sigue siendo `BUDGET_EDIT` = sólo creador/admin.
- Sin acceso al evento → 404 (guard). Dentro del evento sin el permiso → 403 (guard).
- Membresía del creador: no se revoca, no cambia de rol, no recibe grant → 422 `OWNER_MEMBERSHIP_IMMUTABLE`.
- Membresía REVOKED o de otro evento en PATCH/DELETE → 404 `MEMBER_NOT_FOUND`. Aceptar/rechazar sin INVITED propia → 404 `NO_PENDING_INVITATION`.
- Frontend (su `CLAUDE.md`): sin `React.FC`; cero valores arbitrarios de Tailwind; sin `dark:`/`slate-*`; sin `<button>` crudo en `features/` (usar `Button`/`IconButton`); una `*-screen.tsx` sólo ensambla; respuestas validadas con zod; textos de UI en inglés.
- Frontend gates: `npx vitest run <ficheros>`; al final `npm test && npm run typecheck && npm run lint && npx prettier --check .`.
- Commits terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Grant concedido mientras otro request revoca la misma membresía** → la reinvitación debe nacer en NONE igualmente. → Task 4 (paridad: `invitarMiembro` borra un grant huérfano).
- **El creador intenta quitarse a sí mismo** (DELETE de su propia fila, o PATCH con `budgetAccess: 'none'` sobre ella) → 422, y sigue siendo dueño con `edit`. → Task 6 (e2e).
- **Un miembro con VIEW pierde el permiso mientras tiene Budget abierto** → la siguiente petición de gastos da 403 y la vista no se rompe (muestra el 404 de la pantalla). → Task 8 (e2e: retirar → 403 inmediato) ; la UI ya trata `none` como NotFound.
- **Invitado recién registrado sin eventos** entra en `/dashboard` → ve sus invitaciones, no el asistente de crear evento. → Task 11.
- **Aceptar dos veces** (doble clic o dos pestañas) → la segunda es 404 y la UI no se queda colgada: quita la invitación igualmente y recarga eventos. → Task 6 (e2e) y Task 11 (store).

---

## File Structure

Backend (`wedding-planner-backend`):

```
prisma/schema.prisma + prisma/migrations/20261014120000_event_budget_grants/migration.sql
docs/DATABASE.md                                         sección event_budget_grants
src/modules/events/domain/event-access.ts (+test)        budgetView, reglaPresupuesto, listado con budgetView
src/modules/events/domain/presupuesto.test.ts            matriz de la regla
src/modules/events/domain/membresia.ts (+test)           transiciones puras
src/modules/events/domain/event-errors.ts                MiembroNoEncontrado, SinInvitacionPendiente, CreadorIntocable
src/modules/events/application/event.repository.ts       puerto ampliado
src/modules/events/infrastructure/prisma-event.repository.ts
src/modules/events/infrastructure/event.repository.fake.ts
src/modules/events/infrastructure/event.repository.paridad.test.ts
src/modules/events/application/event-access.service.ts   pasa budgetView
src/modules/events/application/list-events.use-case.ts   devuelve EventoAccesible[]
src/modules/events/application/members.use-cases.ts (+test)  listar/actualizar/revocar/mis invitaciones/aceptar/rechazar
src/modules/events/application/invite-member.use-case.ts (+test)  cola `members`, invitedByName
src/modules/events/interfaces/events.controller.ts       listado con budgetView, invitar = OWNER
src/modules/events/interfaces/members.controller.ts      rutas de miembros + aceptar/rechazar
src/modules/events/interfaces/my-invitations.controller.ts  GET /me/invitations
src/modules/events/interfaces/members.dto.ts (+test)
src/modules/events/interfaces/member-invitation.processor.ts (+test)
src/modules/events/events.module.ts
src/modules/queue/application/queue.port.ts              QueueName + 'members'
src/modules/mail/application/member-invitation-renderer.port.ts
src/modules/mail/infrastructure/templates/member-invitation.tsx (+test)
src/modules/mail/mail.module.ts
src/modules/guests/application/send-invitations.use-case.ts  comentario desactualizado
test/e2e/members.e2e.test.ts                             flujo de miembros
test/e2e/budget-visibility.e2e.test.ts                   matriz de acceso con y sin grant
```

Frontend (`wedding-planner-frontend`):

```
src/features/members/members-model.ts                    esquemas zod Member / Invitation
src/features/members/members-api.ts (+test)
src/lib/invitations-store.ts (+test)                     zustand, atado a la sesión
src/app/event-switcher.tsx (+test)                       bloque Invitations
src/app/app-layout.tsx (+test)                           carga invitaciones y las pasa al switcher
src/app/dashboard-redirect.tsx (+test)                   invitaciones sin eventos
src/features/members/pending-invitations.tsx (+test)     lista Accept/Decline reutilizable
src/features/members/use-members.ts (+test)
src/features/members/members-list.tsx (+test)
src/features/members/invite-member-form.tsx (+test)
src/features/members/members-section.tsx (+test)
src/features/members/share-budget-modal.tsx (+test)
src/features/members/revoke-member-modal.tsx
src/features/settings/event-settings-screen.tsx (+test)  monta MembersSection
src/features/budget/budget-screen.tsx (+test)            botón Share
src/features/dashboard/dashboard-screen.test.tsx         view: tarjeta sí
src/features/event-vendors/event-vendors-screen.test.tsx view: importes sí, acciones no
```

---

## Backend

### Task 1: tabla `event_budget_grants`

**Files:**
- Modify: `prisma/schema.prisma` (modelo `EventMembership`, modelo nuevo)
- Create: `prisma/migrations/20261014120000_event_budget_grants/migration.sql`
- Modify: `docs/DATABASE.md` (sección nueva tras `events`)
- Test: `test/support/schema.test.ts`

**Interfaces:**
- Produces: modelo Prisma `EventBudgetGrant { id, membershipId @unique, grantedById, createdAt }`, relación `EventMembership.budgetGrant EventBudgetGrant?` con `onDelete: Cascade`. Cliente: `prisma.eventBudgetGrant`.

- [ ] **Step 1: Test que falla** — al final de `test/support/schema.test.ts`, dentro del `describe` principal:

```ts
  describe('event_budget_grants', () => {
    it('un grant por membresía, y se borra con ella', async () => {
      const miembro = await prisma.user.create({
        data: { email: 'grant@test.com', passwordHash: 'x', fullName: 'Grant' },
      })
      const membresia = await prisma.eventMembership.create({
        data: { eventId, userId: miembro.id, role: 'PLANNER', status: 'ACTIVE' },
      })
      await prisma.eventBudgetGrant.create({
        data: { membershipId: membresia.id, grantedById: miembro.id },
      })
      await expect(
        prisma.eventBudgetGrant.create({
          data: { membershipId: membresia.id, grantedById: miembro.id },
        }),
      ).rejects.toThrow()

      await prisma.eventMembership.delete({ where: { id: membresia.id } })
      expect(
        await prisma.eventBudgetGrant.count({ where: { membershipId: membresia.id } }),
      ).toBe(0)
    })
  })
```

- [ ] **Step 2: Verlo fallar** — `npx vitest run test/support/schema.test.ts -t event_budget_grants` → FAIL (`prisma.eventBudgetGrant` no existe / error de tipos).

- [ ] **Step 3: Esquema** — en `prisma/schema.prisma`, dentro de `model EventMembership`, tras la línea `user  User  @relation(...)`:

```prisma
  budgetGrant EventBudgetGrant?
```

y debajo del modelo `EventMembership`:

```prisma
/// Permiso de VER el presupuesto que el creador concede a UN miembro. Existir =
/// VIEW; no existir = NONE (el valor por defecto de todo miembro, nuevo o
/// antiguo, sin rellenar nada). Editar es siempre del creador, así que no hay
/// columna de nivel. Tabla aparte y no columna de `EventMembership` por decisión
/// del usuario (spec 2026-10-13 §2). Lo que la base no puede impedir —concederlo
/// al creador o a una membresía REVOKED— lo rechaza el caso de uso.
model EventBudgetGrant {
  id           String   @id @default(uuid()) @db.Uuid
  membershipId String   @unique @db.Uuid
  grantedById  String   @db.Uuid
  createdAt    DateTime @default(now())

  membership EventMembership @relation(fields: [membershipId], references: [id], onDelete: Cascade)

  @@map("event_budget_grants")
}
```

- [ ] **Step 4: Migración** — crear `prisma/migrations/20261014120000_event_budget_grants/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "event_budget_grants" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "grantedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_budget_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "event_budget_grants_membershipId_key" ON "event_budget_grants"("membershipId");

-- AddForeignKey
ALTER TABLE "event_budget_grants" ADD CONSTRAINT "event_budget_grants_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "event_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Comprobar que coincide con lo que Prisma genera: con Docker arriba,
`npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_URL" --exit-code`
(una base vacía de Testcontainers o local sirve como shadow) debe salir con 0. Si muestra diferencias, copiar el SQL que propone en `migration.sql`. Después `npx prisma generate`.

- [ ] **Step 5: Verlo pasar** — `npx vitest run test/support/schema.test.ts` → PASS.

- [ ] **Step 6: Documentar** — en `docs/DATABASE.md`, tras la sección `### \`events\``, añadir:

```markdown
### `event_budget_grants`

Belongs to an `EventMembership` (`membershipId` unique, `onDelete: Cascade`). A row means the event owner granted that member permission to **view** the budget (expenses, budget summary, the event's `totalBudget` and vendors' `assignedBudget`); no row means no access. Editing the budget is always reserved to the event owner, so there is no level column. `grantedById` records who granted it.

Enforced by the use cases, not by the database: a grant cannot be given to the owner's own membership nor to a `REVOKED` membership. Revoking a membership deletes its grant in the same transaction, and re-inviting deletes any leftover grant, so a re-invited member always starts without budget access. Changing a member's role keeps the grant.
```

- [ ] **Step 7: Gates y commit**

```bash
npm run typecheck && npm run lint && npx prettier --check .
git add prisma/schema.prisma prisma/migrations/20261014120000_event_budget_grants docs/DATABASE.md test/support/schema.test.ts
git commit -m "feat: tabla event_budget_grants para el permiso de ver el presupuesto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: regla de presupuesto con `budgetView`

**Files:**
- Modify: `src/modules/events/domain/event-access.ts`
- Modify: `src/modules/events/domain/presupuesto.test.ts`, `src/modules/events/domain/event-access.test.ts`
- Modify (añadir `budgetView: false` a cada literal `{ kind: 'member', ... }`): `src/modules/events/application/event-access.service.test.ts`, `src/modules/events/interfaces/event-access.guard.test.ts`, `test/e2e/event-access.e2e.test.ts` (si construye el objeto; si sólo compara el `access` de la respuesta, añadir `budgetView` al esperado), y cualquier otro que `grep -rn "kind: 'member'" src test` liste.
- Modify: `src/modules/events/infrastructure/prisma-event.repository.ts`, `event.repository.fake.ts`, `application/event.repository.ts`, `application/event-access.service.ts` (sólo `buscarMembresiaActiva`)
- Test: `src/modules/events/infrastructure/event.repository.paridad.test.ts`

**Interfaces:**
- Produces:
  - `EventAccess` member: `{ kind: 'member'; role: EventRole; owner: boolean; budgetView: boolean }`
  - `accesoAlPresupuesto(acceso: EventAccess): BudgetAccess` (misma firma)
  - `accesoAlPresupuestoEnListado(ownerId: string, userId: string, budgetView: boolean): BudgetAccess`
  - `EventRepository.buscarMembresiaActiva(eventId, userId): Promise<{ role: EventRole; owner: boolean; budgetView: boolean } | null>`

- [ ] **Step 1: Tests de dominio que fallan** — reemplazar `presupuesto.test.ts` entero:

```ts
import { describe, expect, it } from 'vitest'

import { accesoAlPresupuesto, accesoAlPresupuestoEnListado } from './presupuesto'

const miembro = (owner: boolean, budgetView: boolean, role: 'COUPLE' | 'PLANNER' = 'COUPLE') =>
  ({ kind: 'member', role, owner, budgetView }) as const

describe('accesoAlPresupuesto', () => {
  it.each([
    [{ kind: 'admin' } as const, 'edit'],
    [miembro(true, false), 'edit'],
    // Un grant en la fila del creador no le baja a `view`: el creador edita.
    [miembro(true, true), 'edit'],
    [miembro(false, false), 'none'],
    [miembro(false, true), 'view'],
    [miembro(false, true, 'PLANNER'), 'view'],
    [miembro(false, false, 'PLANNER'), 'none'],
    [{ kind: 'vendor', eventVendorId: 'ev-v' } as const, 'none'],
    [{ kind: 'none' } as const, 'none'],
  ])('%o → %s', (acceso, esperado) => {
    expect(accesoAlPresupuesto(acceso)).toBe(esperado)
  })
})

describe('accesoAlPresupuestoEnListado', () => {
  it('el creador edita, un miembro con grant ve y el resto no ve nada', () => {
    expect(accesoAlPresupuestoEnListado('u-1', 'u-1', false)).toBe('edit')
    expect(accesoAlPresupuestoEnListado('u-1', 'u-2', true)).toBe('view')
    expect(accesoAlPresupuestoEnListado('u-1', 'u-2', false)).toBe('none')
  })

  it('coincide con accesoAlPresupuesto para todo miembro posible', () => {
    // Las dos reglas no pueden derivar: el listado y el evento suelto tienen
    // que enseñar lo mismo a la misma persona.
    for (const owner of [true, false]) {
      for (const budgetView of [true, false]) {
        expect(
          accesoAlPresupuestoEnListado('u-1', owner ? 'u-1' : 'u-2', budgetView),
          `owner=${owner} budgetView=${budgetView}`,
        ).toBe(accesoAlPresupuesto(miembro(owner, budgetView)))
      }
    }
  })
})
```

En `event-access.test.ts`, añadir `budgetView: false` a todos los literales de miembro existentes y este caso al final del `describe('permisosDe — presupuesto')`:

```ts
  it('un miembro con grant lleva BUDGET_VIEW pero no BUDGET_EDIT', () => {
    expect(
      permisosDe({ kind: 'member', role: 'PLANNER', owner: false, budgetView: true }),
    ).toEqual(['PLANNER', 'BUDGET_VIEW'])
  })
```

- [ ] **Step 2: Verlos fallar** — `npx vitest run src/modules/events/domain` → FAIL (tipo sin `budgetView`, `'none'` en vez de `'view'`).

- [ ] **Step 3: Implementar** — en `event-access.ts`:

Sustituir el miembro de la unión `EventAccess` por:

```ts
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
```

Sustituir el bloque desde el docblock de `BudgetAccess` hasta el final del fichero por:

```ts
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
  if (acceso.kind === 'admin') return reglaPresupuesto({ admin: true, owner: false, budgetView: false })
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
```

- [ ] **Step 4: Paridad que falla** — en `event.repository.paridad.test.ts`, cambiar los dos `toEqual` del test `buscarMembresiaActiva marca owner…` para incluir `budgetView: false`, y añadir:

```ts
  it('buscarMembresiaActiva lee el grant de presupuesto en la misma consulta', async () => {
    const otro = await prisma.user.create({
      data: { email: `grant-${Date.now()}@paridad.test`, passwordHash: 'x', fullName: 'Con grant' },
    })
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      if (repo instanceof EventRepositoryEnMemoria) {
        repo.membresias.push({
          id: `m-${nombre}`,
          eventId: evento.id,
          userId: otro.id,
          role: 'PLANNER',
          status: 'ACTIVE',
          budgetView: true,
        })
      } else {
        const m = await prisma.eventMembership.create({
          data: { eventId: evento.id, userId: otro.id, role: 'PLANNER', status: 'ACTIVE' },
        })
        await prisma.eventBudgetGrant.create({ data: { membershipId: m.id, grantedById: ownerId } })
      }
      expect(await repo.buscarMembresiaActiva(evento.id, otro.id), nombre).toEqual({
        role: 'PLANNER',
        owner: false,
        budgetView: true,
      })
    }
  })
```

- [ ] **Step 5: Puerto, doble y Prisma**

`application/event.repository.ts` — cambiar la firma de `buscarMembresiaActiva`:

```ts
  buscarMembresiaActiva(
    eventId: string,
    userId: string,
  ): Promise<{ role: EventRole; owner: boolean; budgetView: boolean } | null>
```

y añadir al docblock: "`budgetView` (grant de presupuesto) también sale de esa lectura."

`event.repository.fake.ts` — en `MembresiaEnMemoria` añadir `budgetView?: boolean` (documentar: "`true` = tiene fila en `event_budget_grants`") y en `buscarMembresiaActiva` devolver:

```ts
    return Promise.resolve({
      role: membresia.role,
      owner: evento?.ownerId === userId,
      budgetView: membresia.budgetView ?? false,
    })
```

(firma de retorno actualizada igual que el puerto).

`prisma-event.repository.ts` — `buscarMembresiaActiva`:

```ts
    const fila = await this.prisma.eventMembership.findFirst({
      where: { eventId, userId, status: MEMBRESIA_CON_ACCESO },
      select: {
        role: true,
        event: { select: { ownerId: true } },
        budgetGrant: { select: { id: true } },
      },
    })
    return fila === null
      ? null
      : {
          role: fila.role,
          owner: fila.event.ownerId === userId,
          budgetView: fila.budgetGrant !== null,
        }
```

`application/event-access.service.ts`:

```ts
    if (membresia !== null) {
      return {
        kind: 'member',
        role: membresia.role,
        owner: membresia.owner,
        budgetView: membresia.budgetView,
      }
    }
```

- [ ] **Step 6: Llamada del listado** — `events.controller.ts` sigue llamando a `accesoAlPresupuestoEnListado(evento.ownerId, yo.id)`, que ahora pide tres argumentos. Para que compile en esta tarea, pasar `false` como tercero con el comentario `// Task 3 lo sustituye por el grant real del listado.`. La Task 3 lo sustituye.

- [ ] **Step 7: Actualizar literales** — `grep -rn "kind: 'member'" src test` y añadir `budgetView: false` (o `true` donde el test quiera presupuesto) a cada literal. En `create-event.use-case.test.ts` el `toEqual` de `buscarMembresiaActiva` gana `budgetView: false`.

- [ ] **Step 8: Verlo pasar** — `npx vitest run src/modules/events test/e2e/event-access.e2e.test.ts` → PASS; `npm run typecheck` limpio.

- [ ] **Step 9: Commit**

```bash
git add -A src/modules/events test/e2e/event-access.e2e.test.ts
git commit -m "feat: el grant de presupuesto da 'view' a un miembro

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: el listado `GET /events` con el grant de cada evento

**Files:**
- Modify: `src/modules/events/application/event.repository.ts`, `infrastructure/prisma-event.repository.ts`, `infrastructure/event.repository.fake.ts`
- Modify: `src/modules/events/application/list-events.use-case.ts`, `interfaces/events.controller.ts`
- Modify: `src/modules/events/application/event-access.service.test.ts:158` (`listarAccesiblesPor` devuelve otra forma)
- Test: `event.repository.paridad.test.ts`

**Interfaces:**
- Consumes: `accesoAlPresupuestoEnListado(ownerId, userId, budgetView)` (Task 2).
- Produces: `export interface EventoAccesible { evento: Event; budgetView: boolean }` en `event.repository.ts`; `listarAccesiblesPor(userId): Promise<EventoAccesible[]>`; `ListEventsUseCase.ejecutar(userId): Promise<EventoAccesible[]>`.

- [ ] **Step 1: Paridad que falla** — añadir:

```ts
  it('listarAccesiblesPor devuelve el grant de quien pregunta en cada evento', async () => {
    const miembro = await prisma.user.create({
      data: { email: `lista-${Date.now()}@paridad.test`, passwordHash: 'x', fullName: 'Lista' },
    })
    for (const [nombre, repo] of sujetos()) {
      const conGrant = await repo.crearConMembresia({ name: 'Con grant', ownerId })
      const sinGrant = await repo.crearConMembresia({ name: 'Sin grant', ownerId })
      for (const [evento, budgetView] of [
        [conGrant, true],
        [sinGrant, false],
      ] as const) {
        if (repo instanceof EventRepositoryEnMemoria) {
          repo.membresias.push({
            id: `${nombre}-${evento.id}`,
            eventId: evento.id,
            userId: miembro.id,
            role: 'COUPLE',
            status: 'ACTIVE',
            budgetView,
          })
        } else {
          const m = await prisma.eventMembership.create({
            data: { eventId: evento.id, userId: miembro.id, role: 'COUPLE', status: 'ACTIVE' },
          })
          if (budgetView) {
            await prisma.eventBudgetGrant.create({ data: { membershipId: m.id, grantedById: ownerId } })
          }
        }
      }
      const lista = await repo.listarAccesiblesPor(miembro.id)
      const porNombre = Object.fromEntries(lista.map((a) => [a.evento.name, a.budgetView]))
      expect(porNombre, nombre).toMatchObject({ 'Con grant': true, 'Sin grant': false })
    }
  })
```

- [ ] **Step 2: Verlo fallar** — `npx vitest run src/modules/events/infrastructure/event.repository.paridad.test.ts -t 'grant de quien'` → FAIL.

- [ ] **Step 3: Implementar**

Puerto:

```ts
/** Un evento del listado, con el grant de presupuesto de quien lista. */
export interface EventoAccesible {
  evento: Event
  /** Grant de su membresía ACTIVE; `false` si llega sólo por contratación. */
  budgetView: boolean
}
```

y `listarAccesiblesPor(userId: string): Promise<EventoAccesible[]>` (docblock: "…con el grant de cada uno para `accesoAlPresupuestoEnListado`").

Prisma — en `listarAccesiblesPor`, cambiar el `include` y el mapeo:

```ts
      include: {
        ...CON_CONTEOS,
        memberships: {
          where: { userId, status: MEMBRESIA_CON_ACCESO },
          select: { budgetGrant: { select: { id: true } } },
        },
      },
      ...
    return filas.map(({ memberships, ...fila }) => ({
      evento: this.aDominio(fila),
      budgetView: memberships[0]?.budgetGrant != null,
    }))
```

(`(eventId, userId)` es único, así que `memberships` tiene 0 o 1 filas.)

Doble:

```ts
  listarAccesiblesPor(userId: string): Promise<EventoAccesible[]> {
    const activas = this.membresias.filter(
      (m) => m.userId === userId && m.status === MEMBRESIA_CON_ACCESO,
    )
    ...
    const ids = new Set([...activas.map((m) => m.eventId), ...porContratacion])
    return Promise.resolve(
      this.eventos
        .filter((e) => ids.has(e.id))
        .map((e) => ({
          evento: this.materializar(e),
          budgetView: activas.find((m) => m.eventId === e.id)?.budgetView ?? false,
        })),
    )
  }
```

`list-events.use-case.ts`: tipo de retorno `Promise<EventoAccesible[]>` (importado de `./event.repository`).

`events.controller.ts`, `listarEventos`:

```ts
    const accesibles = await this.listar.ejecutar(yo.id)
    return accesibles.map(({ evento, budgetView }) =>
      this.aRespuesta(evento, accesoAlPresupuestoEnListado(evento.ownerId, yo.id, budgetView)),
    )
```

`event-access.service.test.ts:158`: `expect(await repoDraft.listarAccesiblesPor('vendor-1')).toEqual([])` sigue valiendo; revisar cualquier otro uso que lea `.name` u otros campos y pasar por `.evento`.

- [ ] **Step 4: Verlo pasar** — `npx vitest run src/modules/events test/e2e/budget-visibility.e2e.test.ts test/e2e/event-access.e2e.test.ts` → PASS.

- [ ] **Step 5: Gates y commit**

```bash
npm run typecheck && npm run lint && npx prettier --check .
git add -A src/modules/events
git commit -m "feat: GET /events aplica el grant de presupuesto de cada evento

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: dominio y repositorio del ciclo de vida de la membresía

**Files:**
- Create: `src/modules/events/domain/membresia.ts`, `src/modules/events/domain/membresia.test.ts`
- Modify: `src/modules/events/domain/event-errors.ts`
- Modify: `src/modules/events/application/event.repository.ts`, `infrastructure/prisma-event.repository.ts`, `infrastructure/event.repository.fake.ts`
- Test: `event.repository.paridad.test.ts`

**Interfaces:**
- Produces (dominio, `membresia.ts`):
  - `export interface EstadoMembresia { status: MembershipStatus; owner: boolean }`
  - `export function exigirGestionable(m: EstadoMembresia | null): asserts m is EstadoMembresia` — lanza `MiembroNoEncontradoError` si `null` o `REVOKED`, `CreadorIntocableError` si `owner`.
  - `export function exigirInvitacionPendiente(m: { status: MembershipStatus } | null): asserts m is { status: 'INVITED' }` — lanza `SinInvitacionPendienteError` si no es INVITED.
- Produces (errores, `event-errors.ts`): `MiembroNoEncontradoError` (404, `MEMBER_NOT_FOUND`), `SinInvitacionPendienteError` (404, `NO_PENDING_INVITATION`), `CreadorIntocableError` (422, `OWNER_MEMBERSHIP_IMMUTABLE`).
- Produces (puerto `EventRepository`):

```ts
export interface MiembroPersistido {
  id: string
  userId: string
  fullName: string
  email: string
  role: EventRole
  status: 'INVITED' | 'ACTIVE'
  owner: boolean
  budgetView: boolean
}

export interface MembresiaGestionable {
  id: string
  userId: string
  role: EventRole
  status: MembershipStatus
  owner: boolean
  budgetView: boolean
}

export interface CambiosMembresia {
  role?: EventRole | undefined
  budgetView?: boolean | undefined
}

export interface InvitacionPendiente {
  membershipId: string
  eventId: string
  eventName: string
  role: EventRole
  invitedByName: string | null
}

listarMiembros(eventId: string): Promise<MiembroPersistido[]>
buscarMembresiaPorId(eventId: string, membershipId: string): Promise<MembresiaGestionable | null>
actualizarMembresia(eventId: string, membershipId: string, cambios: CambiosMembresia, actorId: string): Promise<boolean>
revocarMembresia(eventId: string, membershipId: string, actorId: string, motivo: 'revoked' | 'declined'): Promise<boolean>
aceptarInvitacion(eventId: string, userId: string): Promise<boolean>
listarInvitacionesPendientes(userId: string): Promise<InvitacionPendiente[]>
```

`MembresiaPersistida` gana `userId` no hace falta: `buscarMembresia` se queda como está.

- [ ] **Step 1: Tests de dominio** — `membresia.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { exigirGestionable, exigirInvitacionPendiente } from './membresia'

describe('exigirGestionable', () => {
  it('deja pasar a un miembro INVITED o ACTIVE que no es el creador', () => {
    expect(() => exigirGestionable({ status: 'INVITED', owner: false })).not.toThrow()
    expect(() => exigirGestionable({ status: 'ACTIVE', owner: false })).not.toThrow()
  })

  it('una membresía que no existe o está REVOKED es 404: no se lista, no se gestiona', () => {
    expect(() => exigirGestionable(null)).toThrow(expect.objectContaining({ code: 'MEMBER_NOT_FOUND', httpStatus: 404 }))
    expect(() => exigirGestionable({ status: 'REVOKED', owner: false })).toThrow(
      expect.objectContaining({ code: 'MEMBER_NOT_FOUND' }),
    )
  })

  it('la fila del creador es intocable: 422', () => {
    expect(() => exigirGestionable({ status: 'ACTIVE', owner: true })).toThrow(
      expect.objectContaining({ code: 'OWNER_MEMBERSHIP_IMMUTABLE', httpStatus: 422 }),
    )
  })
})

describe('exigirInvitacionPendiente', () => {
  it('sólo una INVITED se acepta o rechaza', () => {
    expect(() => exigirInvitacionPendiente({ status: 'INVITED' })).not.toThrow()
  })

  it.each([null, { status: 'ACTIVE' as const }, { status: 'REVOKED' as const }])(
    '%o es 404 NO_PENDING_INVITATION',
    (m) => {
      expect(() => exigirInvitacionPendiente(m)).toThrow(
        expect.objectContaining({ code: 'NO_PENDING_INVITATION', httpStatus: 404 }),
      )
    },
  )
})
```

- [ ] **Step 2: Verlos fallar** — `npx vitest run src/modules/events/domain/membresia.test.ts` → FAIL (módulo no existe).

- [ ] **Step 3: Errores** — al final de `event-errors.ts`:

```ts
/**
 * 404 tanto si la membresía no existe como si es de otro evento o está
 * REVOKED: Members no enseña las revocadas, así que para quien gestiona no
 * existen. El código es propio (no `NOT_FOUND`) porque la UI sí distingue
 * "este miembro ya no está" de "este evento no existe".
 */
export class MiembroNoEncontradoError extends NotFoundError {
  constructor() {
    super('Ese miembro no existe en este evento', 'MEMBER_NOT_FOUND')
  }
}

/**
 * Aceptar o rechazar sin una INVITED propia. 404 y sin distinguir "el evento
 * no existe" de "no te invitaron": el mismo criterio que el guard.
 */
export class SinInvitacionPendienteError extends NotFoundError {
  constructor() {
    super('No tienes una invitación pendiente para este evento', 'NO_PENDING_INVITATION')
  }
}

/**
 * La membresía del creador no se revoca, no cambia de rol y no recibe grant:
 * ya edita el presupuesto, y un evento sin creador dentro no tendría quién lo
 * gestionara.
 */
export class CreadorIntocableError extends UnprocessableError {
  constructor() {
    super('La membresía de quien creó el evento no se puede cambiar', 'OWNER_MEMBERSHIP_IMMUTABLE')
  }
}
```

- [ ] **Step 4: Dominio** — `membresia.ts`:

```ts
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
 */
export function exigirGestionable(m: EstadoMembresia | null): asserts m is EstadoMembresia {
  if (m === null || m.status === 'REVOKED') throw new MiembroNoEncontradoError()
  if (m.owner) throw new CreadorIntocableError()
}

/** Aceptar y rechazar sólo existen desde INVITED. */
export function exigirInvitacionPendiente(
  m: { status: MembershipStatus } | null,
): asserts m is { status: 'INVITED' } {
  if (m === null || m.status !== 'INVITED') throw new SinInvitacionPendienteError()
}
```

`npx vitest run src/modules/events/domain/membresia.test.ts` → PASS.

- [ ] **Step 5: Paridad que falla** — en `event.repository.paridad.test.ts` añadir un helper y cuatro casos. El helper siembra un miembro en ambos sujetos por el puerto (`invitarMiembro`) para no duplicar inserciones:

```ts
  /** Usuario nuevo invitado al evento por el puerto; devuelve su membresía. */
  async function invitar(repo: EventRepository, eventId: string, etiqueta: string, role: 'COUPLE' | 'PLANNER' = 'PLANNER') {
    const u = await prisma.user.create({
      data: { email: `${etiqueta}-${randomUUID()}@paridad.test`, passwordHash: 'x', fullName: etiqueta },
    })
    const m = await repo.invitarMiembro({ eventId, userId: u.id, role, invitedById: ownerId })
    return { userId: u.id, membershipId: m.id }
  }
```

(importar `randomUUID` de `node:crypto`). El doble necesita que `listarMiembros` resuelva nombre y email: añadir a `EventRepositoryEnMemoria` un `readonly usuarios: Array<{ id: string; fullName: string; email: string }>` que los tests rellenan; en el helper, si `repo instanceof EventRepositoryEnMemoria`, hacer `repo.usuarios.push({ id: u.id, fullName: etiqueta, email: u.email })` (y lo mismo para el owner en `sujetos()`: `doble.usuarios.push({ id: ownerId, fullName: 'Owner', email: 'owner@paridad.test' })`).

```ts
  it('listarMiembros: creador primero, INVITED y ACTIVE, sin REVOKED, con grant', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      const ana = await invitar(repo, evento.id, 'Ana', 'COUPLE')
      const pia = await invitar(repo, evento.id, 'Pia')
      const fuera = await invitar(repo, evento.id, 'Fuera')
      await repo.aceptarInvitacion(evento.id, ana.userId)
      await repo.actualizarMembresia(evento.id, ana.membershipId, { budgetView: true }, ownerId)
      await repo.revocarMembresia(evento.id, fuera.membershipId, ownerId, 'revoked')
      void pia
      resultados.push(
        (await repo.listarMiembros(evento.id)).map(({ id: _i, userId: _u, email: _e, ...resto }) => resto),
      )
    }
    expect(resultados[0]).toEqual([
      { fullName: 'Owner', role: 'COUPLE', status: 'ACTIVE', owner: true, budgetView: false },
      { fullName: 'Ana', role: 'COUPLE', status: 'ACTIVE', owner: false, budgetView: true },
      { fullName: 'Pia', role: 'PLANNER', status: 'INVITED', owner: false, budgetView: false },
    ])
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('actualizarMembresia cambia rol y grant; cambiar el rol conserva el grant', async () => {
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      const m = await invitar(repo, evento.id, 'Rol')
      expect(await repo.actualizarMembresia(evento.id, m.membershipId, { budgetView: true }, ownerId)).toBe(true)
      expect(await repo.actualizarMembresia(evento.id, m.membershipId, { role: 'COUPLE' }, ownerId)).toBe(true)
      expect(await repo.buscarMembresiaPorId(evento.id, m.membershipId), nombre).toMatchObject({
        role: 'COUPLE',
        status: 'INVITED',
        owner: false,
        budgetView: true,
      })
      expect(await repo.actualizarMembresia(evento.id, m.membershipId, { budgetView: false }, ownerId)).toBe(true)
      expect((await repo.buscarMembresiaPorId(evento.id, m.membershipId))?.budgetView, nombre).toBe(false)
      // De otro evento: no existe.
      const otro = await repo.crearConMembresia({ name: 'Otra', ownerId })
      expect(await repo.buscarMembresiaPorId(otro.id, m.membershipId), nombre).toBeNull()
      expect(await repo.actualizarMembresia(otro.id, m.membershipId, { role: 'PLANNER' }, ownerId)).toBe(false)
    }
  })

  it('revocar borra el grant; reinvitar nace sin grant aunque quedara uno huérfano', async () => {
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      const m = await invitar(repo, evento.id, 'Revocado')
      await repo.actualizarMembresia(evento.id, m.membershipId, { budgetView: true }, ownerId)
      expect(await repo.revocarMembresia(evento.id, m.membershipId, ownerId, 'revoked')).toBe(true)
      expect(await repo.buscarMembresiaPorId(evento.id, m.membershipId), nombre).toMatchObject({
        status: 'REVOKED',
        budgetView: false,
      })
      // Revocar dos veces: la segunda no escribe.
      expect(await repo.revocarMembresia(evento.id, m.membershipId, ownerId, 'revoked')).toBe(false)
      // Grant huérfano sobre la REVOKED (la carrera grant/revocar): reinvitar lo limpia.
      if (repo instanceof EventRepositoryEnMemoria) {
        const fila = repo.membresias.find((x) => x.id === m.membershipId)
        if (fila !== undefined) fila.budgetView = true
      } else {
        await prisma.eventBudgetGrant.create({ data: { membershipId: m.membershipId, grantedById: ownerId } })
      }
      await repo.invitarMiembro({ eventId: evento.id, userId: m.userId, role: 'PLANNER', invitedById: ownerId })
      expect((await repo.buscarMembresiaPorId(evento.id, m.membershipId))?.budgetView, nombre).toBe(false)
    }
  })

  it('aceptar sólo desde INVITED; las pendientes de un usuario con quién invitó', async () => {
    const resultados = []
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: `Boda ${nombre}`, ownerId })
      const m = await invitar(repo, evento.id, 'Invitada')
      const pendientes = await repo.listarInvitacionesPendientes(m.userId)
      resultados.push(pendientes.map(({ membershipId: _m, eventId: _e, ...resto }) => resto))
      expect(await repo.aceptarInvitacion(evento.id, m.userId)).toBe(true)
      expect(await repo.aceptarInvitacion(evento.id, m.userId)).toBe(false)
      expect(await repo.listarInvitacionesPendientes(m.userId), nombre).toEqual([])
      expect(await repo.buscarMembresiaActiva(evento.id, m.userId), nombre).not.toBeNull()
    }
    expect(resultados[0]).toEqual([
      { eventName: 'Boda doble', role: 'PLANNER', invitedByName: 'Owner' },
    ])
    expect(resultados[1]).toEqual([
      { eventName: 'Boda prisma', role: 'PLANNER', invitedByName: 'Owner' },
    ])
  })
```

Verlos fallar: `npx vitest run src/modules/events/infrastructure/event.repository.paridad.test.ts` → FAIL (métodos inexistentes).

- [ ] **Step 6: Puerto** — añadir a `event.repository.ts` los tipos de "Interfaces" y estos métodos con su docblock:

```ts
  /**
   * INVITED y ACTIVE (las REVOKED no se gestionan), creador primero y luego
   * por `createdAt` asc, `id` de desempate. Nombre y email salen del join con
   * `users` en la misma consulta.
   */
  listarMiembros(eventId: string): Promise<MiembroPersistido[]>

  /** En cualquier estado, pero sólo si es de ESTE evento. */
  buscarMembresiaPorId(eventId: string, membershipId: string): Promise<MembresiaGestionable | null>

  /**
   * Cambia rol y/o grant + `AuditLog`, en una transacción. Escritura
   * CONDICIONAL: sólo si la membresía sigue INVITED o ACTIVE en este evento;
   * `false` si cambió por debajo (el caso de uso responde 404). El `UPDATE`
   * bloquea la fila hasta el commit, así que un DELETE concurrente espera.
   */
  actualizarMembresia(
    eventId: string,
    membershipId: string,
    cambios: CambiosMembresia,
    actorId: string,
  ): Promise<boolean>

  /**
   * → REVOKED, borra el grant y escribe `AuditLog` (`event.member.revoked` o
   * `event.member.declined`), en una transacción y condicional como la de
   * arriba. Sirve para revocar, cancelar una invitación y rechazarla.
   */
  revocarMembresia(
    eventId: string,
    membershipId: string,
    actorId: string,
    motivo: 'revoked' | 'declined',
  ): Promise<boolean>

  /** INVITED → ACTIVE de la membresía de `userId` + `AuditLog`. `false` si no estaba INVITED. */
  aceptarInvitacion(eventId: string, userId: string): Promise<boolean>

  /** INVITED del usuario, más recientes primero, con nombre del evento y de quien invitó. */
  listarInvitacionesPendientes(userId: string): Promise<InvitacionPendiente[]>
```

Y en el docblock de `invitarMiembro` añadir: "Borra además cualquier grant de la membresía: una reinvitación nace sin acceso al presupuesto aunque una carrera hubiera dejado uno."

- [ ] **Step 7: Adaptador Prisma** — en `prisma-event.repository.ts`. Importar `MembershipStatus` y los tipos nuevos. Constante:

```ts
/** Estados que se gestionan: una REVOKED no se lista ni se toca. */
const VIVAS = ['INVITED', 'ACTIVE'] as const satisfies readonly MembershipStatus[]
```

En `invitarMiembro`, antes del `auditLog.create`:

```ts
      await tx.eventBudgetGrant.deleteMany({ where: { membershipId: membresia.id } })
```

Métodos nuevos:

```ts
  async listarMiembros(eventId: string): Promise<MiembroPersistido[]> {
    const filas = await this.prisma.eventMembership.findMany({
      where: { eventId, status: { in: [...VIVAS] } },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        createdAt: true,
        user: { select: { fullName: true, email: true } },
        event: { select: { ownerId: true } },
        budgetGrant: { select: { id: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const miembros = filas.map((f) => ({
      id: f.id,
      userId: f.userId,
      fullName: f.user.fullName,
      email: f.user.email,
      role: f.role,
      // El `where` sólo deja pasar estos dos.
      status: f.status as 'INVITED' | 'ACTIVE',
      owner: f.event.ownerId === f.userId,
      budgetView: f.budgetGrant !== null,
    }))
    // Creador primero; el resto conserva el orden de la consulta (sort estable).
    return miembros.sort((a, b) => Number(b.owner) - Number(a.owner))
  }

  async buscarMembresiaPorId(
    eventId: string,
    membershipId: string,
  ): Promise<MembresiaGestionable | null> {
    const f = await this.prisma.eventMembership.findFirst({
      where: { id: membershipId, eventId },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        event: { select: { ownerId: true } },
        budgetGrant: { select: { id: true } },
      },
    })
    return f === null
      ? null
      : {
          id: f.id,
          userId: f.userId,
          role: f.role,
          status: f.status,
          owner: f.event.ownerId === f.userId,
          budgetView: f.budgetGrant !== null,
        }
  }

  async actualizarMembresia(
    eventId: string,
    membershipId: string,
    cambios: CambiosMembresia,
    actorId: string,
  ): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      // `updatedAt` explícito: con `data` vacío (sólo cambia el grant) Prisma
      // no emitiría UPDATE y no habría ni bloqueo ni comprobación de estado.
      const { count } = await tx.eventMembership.updateMany({
        where: { id: membershipId, eventId, status: { in: [...VIVAS] } },
        data: { updatedAt: new Date(), ...(cambios.role !== undefined ? { role: cambios.role } : {}) },
      })
      if (count === 0) return false

      if (cambios.budgetView === true) {
        await tx.eventBudgetGrant.upsert({
          where: { membershipId },
          create: { membershipId, grantedById: actorId },
          update: {},
        })
      } else if (cambios.budgetView === false) {
        await tx.eventBudgetGrant.deleteMany({ where: { membershipId } })
      }

      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          eventId,
          action: 'event.member.updated',
          target: `membership:${membershipId}`,
          metadata: {
            ...(cambios.role !== undefined ? { role: cambios.role } : {}),
            ...(cambios.budgetView !== undefined ? { budgetView: cambios.budgetView } : {}),
          },
        },
      })
      return true
    })
  }

  async revocarMembresia(
    eventId: string,
    membershipId: string,
    actorId: string,
    motivo: 'revoked' | 'declined',
  ): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.eventMembership.updateMany({
        where: { id: membershipId, eventId, status: { in: [...VIVAS] } },
        data: { status: 'REVOKED' },
      })
      if (count === 0) return false
      await tx.eventBudgetGrant.deleteMany({ where: { membershipId } })
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          eventId,
          action: `event.member.${motivo}`,
          target: `membership:${membershipId}`,
        },
      })
      return true
    })
  }

  async aceptarInvitacion(eventId: string, userId: string): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.eventMembership.updateMany({
        where: { eventId, userId, status: 'INVITED' },
        data: { status: MEMBRESIA_CON_ACCESO },
      })
      if (count === 0) return false
      await tx.auditLog.create({
        data: { actorUserId: userId, eventId, action: 'event.member.accepted', target: `user:${userId}` },
      })
      return true
    })
  }

  async listarInvitacionesPendientes(userId: string): Promise<InvitacionPendiente[]> {
    const filas = await this.prisma.eventMembership.findMany({
      where: { userId, status: 'INVITED' },
      select: {
        id: true,
        eventId: true,
        role: true,
        invitedById: true,
        event: { select: { name: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    })
    // `invitedById` no tiene relación en el esquema: una consulta para todos.
    const ids = [...new Set(filas.flatMap((f) => (f.invitedById === null ? [] : [f.invitedById])))]
    const quienes = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    })
    const nombre = new Map(quienes.map((u) => [u.id, u.fullName]))
    return filas.map((f) => ({
      membershipId: f.id,
      eventId: f.eventId,
      eventName: f.event.name,
      role: f.role,
      invitedByName: f.invitedById === null ? null : (nombre.get(f.invitedById) ?? null),
    }))
  }
```

- [ ] **Step 8: Doble** — en `event.repository.fake.ts`: `MembresiaEnMemoria` gana `invitedById?: string` y `actualizadaEn?: number` (orden de pendientes). Añadir `readonly usuarios: Array<{ id: string; fullName: string; email: string }> = []`. En `invitarMiembro`: `membresia.budgetView = false`, `membresia.invitedById = datos.invitedById`, `membresia.actualizadaEn = ++this.reloj` (con `private reloj = 0`). En `crearConMembresia` dar `id` a la membresía (ya lo hace). Métodos:

```ts
  listarMiembros(eventId: string): Promise<MiembroPersistido[]> {
    const ownerId = this.eventos.find((e) => e.id === eventId)?.ownerId
    const vivas = this.membresias.filter(
      (m) => m.eventId === eventId && (m.status === 'INVITED' || m.status === 'ACTIVE'),
    )
    const miembros = vivas.map((m) => {
      const u = this.usuarios.find((x) => x.id === m.userId)
      return {
        id: m.id ?? '',
        userId: m.userId,
        fullName: u?.fullName ?? '',
        email: u?.email ?? '',
        role: m.role,
        status: m.status as 'INVITED' | 'ACTIVE',
        owner: m.userId === ownerId,
        budgetView: m.budgetView ?? false,
      }
    })
    // Inserción = `createdAt` asc, como Prisma; creador primero.
    return Promise.resolve(miembros.sort((a, b) => Number(b.owner) - Number(a.owner)))
  }

  buscarMembresiaPorId(eventId: string, membershipId: string): Promise<MembresiaGestionable | null> {
    const m = this.membresias.find((x) => x.id === membershipId && x.eventId === eventId)
    if (m === undefined) return Promise.resolve(null)
    const ownerId = this.eventos.find((e) => e.id === eventId)?.ownerId
    return Promise.resolve({
      id: membershipId,
      userId: m.userId,
      role: m.role,
      status: m.status,
      owner: m.userId === ownerId,
      budgetView: m.budgetView ?? false,
    })
  }

  actualizarMembresia(
    eventId: string,
    membershipId: string,
    cambios: CambiosMembresia,
    actorId: string,
  ): Promise<boolean> {
    const m = this.viva(eventId, membershipId)
    if (m === undefined) return Promise.resolve(false)
    if (cambios.role !== undefined) m.role = cambios.role
    if (cambios.budgetView !== undefined) m.budgetView = cambios.budgetView
    this.auditoria.push({ actorUserId: actorId, eventId, action: 'event.member.updated', target: `membership:${membershipId}` })
    return Promise.resolve(true)
  }

  revocarMembresia(
    eventId: string,
    membershipId: string,
    actorId: string,
    motivo: 'revoked' | 'declined',
  ): Promise<boolean> {
    const m = this.viva(eventId, membershipId)
    if (m === undefined) return Promise.resolve(false)
    m.status = 'REVOKED'
    m.budgetView = false
    this.auditoria.push({ actorUserId: actorId, eventId, action: `event.member.${motivo}`, target: `membership:${membershipId}` })
    return Promise.resolve(true)
  }

  aceptarInvitacion(eventId: string, userId: string): Promise<boolean> {
    const m = this.membresias.find((x) => x.eventId === eventId && x.userId === userId && x.status === 'INVITED')
    if (m === undefined) return Promise.resolve(false)
    m.status = MEMBRESIA_CON_ACCESO
    this.auditoria.push({ actorUserId: userId, eventId, action: 'event.member.accepted', target: `user:${userId}` })
    return Promise.resolve(true)
  }

  listarInvitacionesPendientes(userId: string): Promise<InvitacionPendiente[]> {
    const pendientes = this.membresias
      .filter((m) => m.userId === userId && m.status === 'INVITED')
      .sort((a, b) => (b.actualizadaEn ?? 0) - (a.actualizadaEn ?? 0))
    return Promise.resolve(
      pendientes.map((m) => ({
        membershipId: m.id ?? '',
        eventId: m.eventId,
        eventName: this.materializar(this.eventos.find((e) => e.id === m.eventId) ?? { id: m.eventId, ownerId: '' }).name,
        role: m.role,
        invitedByName:
          m.invitedById === undefined ? null : (this.usuarios.find((u) => u.id === m.invitedById)?.fullName ?? null),
      })),
    )
  }

  /** INVITED o ACTIVE de este evento: lo mismo que el `WHERE` condicional de Prisma. */
  private viva(eventId: string, membershipId: string): MembresiaEnMemoria | undefined {
    return this.membresias.find(
      (x) => x.id === membershipId && x.eventId === eventId && (x.status === 'INVITED' || x.status === 'ACTIVE'),
    )
  }
```

- [ ] **Step 9: Verlo pasar** — `npx vitest run src/modules/events` → PASS. Prettier puede reformatear las líneas largas: `npx prettier --write src/modules/events`.

- [ ] **Step 10: Gates y commit**

```bash
npm run typecheck && npm run lint && npx prettier --check .
git add -A src/modules/events
git commit -m "feat: ciclo de vida de la membresía en dominio y repositorio

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: casos de uso de miembros

**Files:**
- Create: `src/modules/events/application/members.use-cases.ts`, `src/modules/events/application/members.use-cases.test.ts`

**Interfaces:**
- Consumes: puerto de Task 4, `exigirGestionable`, `exigirInvitacionPendiente`, `accesoAlPresupuesto` no (la fila trae `owner`/`budgetView`).
- Produces (todas `@Injectable()`, inyectan `EVENT_REPOSITORY`):

```ts
export interface Miembro {
  id: string; userId: string; fullName: string; email: string
  role: EventRole; status: 'INVITED' | 'ACTIVE'; owner: boolean
  budgetAccess: 'none' | 'view' | 'edit'
}
export class ListMembersUseCase { ejecutar(eventId: string): Promise<Miembro[]> }
export class UpdateMemberUseCase {
  ejecutar(d: { eventId: string; membershipId: string; actorId: string; role?: EventRole | undefined; budgetAccess?: 'none' | 'view' | undefined }): Promise<Miembro>
}
export class RevokeMemberUseCase { ejecutar(d: { eventId: string; membershipId: string; actorId: string }): Promise<void> }
export class ListMyInvitationsUseCase { ejecutar(userId: string): Promise<InvitacionPendiente[]> }
export class AcceptInvitationUseCase { ejecutar(eventId: string, userId: string): Promise<void> }
export class DeclineInvitationUseCase { ejecutar(eventId: string, userId: string): Promise<void> }
```

- [ ] **Step 1: Tests que fallan** — `members.use-cases.test.ts`:

```ts
import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'
import {
  AcceptInvitationUseCase,
  DeclineInvitationUseCase,
  ListMembersUseCase,
  ListMyInvitationsUseCase,
  RevokeMemberUseCase,
  UpdateMemberUseCase,
} from './members.use-cases'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const ANA = 'ana'
const PIA = 'pia'

describe('casos de uso de miembros', () => {
  let repo: EventRepositoryEnMemoria
  let piaId: string

  beforeEach(async () => {
    repo = new EventRepositoryEnMemoria()
    repo.eventos.push({ id: EVENTO, ownerId: ANA, name: 'Boda de Ana' })
    repo.membresias.push({ id: 'm-ana', eventId: EVENTO, userId: ANA, role: 'COUPLE', status: 'ACTIVE' })
    repo.usuarios.push(
      { id: ANA, fullName: 'Ana', email: 'ana@test.com' },
      { id: PIA, fullName: 'Pia', email: 'pia@test.com' },
    )
    piaId = (await repo.invitarMiembro({ eventId: EVENTO, userId: PIA, role: 'PLANNER', invitedById: ANA })).id
  })

  it('listar traduce owner/grant a budgetAccess', async () => {
    await repo.actualizarMembresia(EVENTO, piaId, { budgetView: true }, ANA)
    const miembros = await new ListMembersUseCase(repo).ejecutar(EVENTO)
    expect(miembros.map((m) => [m.fullName, m.budgetAccess])).toEqual([
      ['Ana', 'edit'],
      ['Pia', 'view'],
    ])
  })

  it('actualizar concede ver, cambia el rol y devuelve el miembro', async () => {
    const caso = new UpdateMemberUseCase(repo)
    expect(
      await caso.ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA, budgetAccess: 'view' }),
    ).toMatchObject({ budgetAccess: 'view', role: 'PLANNER' })
    expect(
      await caso.ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA, role: 'COUPLE' }),
    ).toMatchObject({ budgetAccess: 'view', role: 'COUPLE' })
  })

  it('actualizar o revocar al creador es 422 y no deja auditoría', async () => {
    const antes = repo.auditoria.length
    await expect(
      new UpdateMemberUseCase(repo).ejecutar({ eventId: EVENTO, membershipId: 'm-ana', actorId: ANA, budgetAccess: 'none' }),
    ).rejects.toMatchObject({ code: 'OWNER_MEMBERSHIP_IMMUTABLE' })
    await expect(
      new RevokeMemberUseCase(repo).ejecutar({ eventId: EVENTO, membershipId: 'm-ana', actorId: ANA }),
    ).rejects.toMatchObject({ code: 'OWNER_MEMBERSHIP_IMMUTABLE' })
    expect(repo.auditoria).toHaveLength(antes)
  })

  it('revocar deja REVOKED, quita el grant y luego es 404', async () => {
    await repo.actualizarMembresia(EVENTO, piaId, { budgetView: true }, ANA)
    const caso = new RevokeMemberUseCase(repo)
    await caso.ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA })
    expect(await repo.buscarMembresiaPorId(EVENTO, piaId)).toMatchObject({ status: 'REVOKED', budgetView: false })
    await expect(caso.ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA })).rejects.toMatchObject({
      code: 'MEMBER_NOT_FOUND',
    })
  })

  it('una membresía de otro evento es 404', async () => {
    await expect(
      new UpdateMemberUseCase(repo).ejecutar({ eventId: 'otro', membershipId: piaId, actorId: ANA, role: 'COUPLE' }),
    ).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
  })

  it('si la membresía cambia entre leer y escribir, 404', async () => {
    // Simula la carrera: la escritura condicional no encuentra una fila viva.
    repo.actualizarMembresia = () => Promise.resolve(false)
    await expect(
      new UpdateMemberUseCase(repo).ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA, role: 'COUPLE' }),
    ).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
  })

  it('el invitado ve su invitación, la acepta y entra; aceptar otra vez es 404', async () => {
    expect(await new ListMyInvitationsUseCase(repo).ejecutar(PIA)).toMatchObject([
      { eventId: EVENTO, eventName: 'Boda de Ana', invitedByName: 'Ana' },
    ])
    const aceptar = new AcceptInvitationUseCase(repo)
    await aceptar.ejecutar(EVENTO, PIA)
    expect(await repo.buscarMembresiaActiva(EVENTO, PIA)).not.toBeNull()
    await expect(aceptar.ejecutar(EVENTO, PIA)).rejects.toMatchObject({ code: 'NO_PENDING_INVITATION' })
  })

  it('rechazar deja REVOKED y no da acceso; sin invitación es 404', async () => {
    const rechazar = new DeclineInvitationUseCase(repo)
    await rechazar.ejecutar(EVENTO, PIA)
    expect(await repo.buscarMembresiaPorId(EVENTO, piaId)).toMatchObject({ status: 'REVOKED' })
    expect(repo.auditoria.at(-1)).toMatchObject({ action: 'event.member.declined', actorUserId: PIA })
    await expect(rechazar.ejecutar(EVENTO, PIA)).rejects.toMatchObject({ code: 'NO_PENDING_INVITATION' })
    await expect(rechazar.ejecutar(EVENTO, 'extraño')).rejects.toMatchObject({ code: 'NO_PENDING_INVITATION' })
  })
})
```

- [ ] **Step 2: Verlos fallar** — `npx vitest run src/modules/events/application/members.use-cases.test.ts` → FAIL.

- [ ] **Step 3: Implementar** — `members.use-cases.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'

import type { EventRole } from '../domain/event-access'
import { MiembroNoEncontradoError, SinInvitacionPendienteError } from '../domain/event-errors'
import { exigirGestionable, exigirInvitacionPendiente } from '../domain/membresia'
import {
  EVENT_REPOSITORY,
  type EventRepository,
  type InvitacionPendiente,
  type MiembroPersistido,
} from './event.repository'

/** Un miembro tal como lo ve quien gestiona: el grant ya traducido a nivel. */
export interface Miembro {
  id: string
  userId: string
  fullName: string
  email: string
  role: EventRole
  status: 'INVITED' | 'ACTIVE'
  owner: boolean
  budgetAccess: 'none' | 'view' | 'edit'
}

function aMiembro({ budgetView, ...m }: MiembroPersistido): Miembro {
  // La fila del creador es `edit` aunque no tenga grant: es la misma regla que
  // `accesoAlPresupuesto` aplica a su `EventAccess`.
  return { ...m, budgetAccess: m.owner ? 'edit' : budgetView ? 'view' : 'none' }
}

@Injectable()
export class ListMembersUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  async ejecutar(eventId: string): Promise<Miembro[]> {
    return (await this.eventos.listarMiembros(eventId)).map(aMiembro)
  }
}

@Injectable()
export class UpdateMemberUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  async ejecutar(datos: {
    eventId: string
    membershipId: string
    actorId: string
    role?: EventRole | undefined
    budgetAccess?: 'none' | 'view' | undefined
  }): Promise<Miembro> {
    exigirGestionable(await this.eventos.buscarMembresiaPorId(datos.eventId, datos.membershipId))
    const escrito = await this.eventos.actualizarMembresia(
      datos.eventId,
      datos.membershipId,
      {
        role: datos.role,
        budgetView: datos.budgetAccess === undefined ? undefined : datos.budgetAccess === 'view',
      },
      datos.actorId,
    )
    // Revocada entre la lectura y la escritura: para quien gestiona ya no existe.
    if (!escrito) throw new MiembroNoEncontradoError()
    const actualizado = (await this.eventos.listarMiembros(datos.eventId)).find(
      (m) => m.id === datos.membershipId,
    )
    if (actualizado === undefined) throw new MiembroNoEncontradoError()
    return aMiembro(actualizado)
  }
}

@Injectable()
export class RevokeMemberUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  /** Revocar a un ACTIVE y cancelar una INVITED son la misma escritura. */
  async ejecutar(datos: { eventId: string; membershipId: string; actorId: string }): Promise<void> {
    exigirGestionable(await this.eventos.buscarMembresiaPorId(datos.eventId, datos.membershipId))
    const escrito = await this.eventos.revocarMembresia(
      datos.eventId,
      datos.membershipId,
      datos.actorId,
      'revoked',
    )
    if (!escrito) throw new MiembroNoEncontradoError()
  }
}

@Injectable()
export class ListMyInvitationsUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  async ejecutar(userId: string): Promise<InvitacionPendiente[]> {
    return await this.eventos.listarInvitacionesPendientes(userId)
  }
}

@Injectable()
export class AcceptInvitationUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  async ejecutar(eventId: string, userId: string): Promise<void> {
    exigirInvitacionPendiente(await this.eventos.buscarMembresia(eventId, userId))
    if (!(await this.eventos.aceptarInvitacion(eventId, userId))) {
      throw new SinInvitacionPendienteError()
    }
  }
}

@Injectable()
export class DeclineInvitationUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  /**
   * Rechazar = REVOKED (spec §3.1): no se añade `DECLINED` al enum. Quien
   * actúa es el propio invitado, y el `AuditLog` lo registra como `declined`.
   */
  async ejecutar(eventId: string, userId: string): Promise<void> {
    const membresia = await this.eventos.buscarMembresia(eventId, userId)
    exigirInvitacionPendiente(membresia)
    if (!(await this.eventos.revocarMembresia(eventId, membresia.id, userId, 'declined'))) {
      throw new SinInvitacionPendienteError()
    }
  }
}
```

Nota: `exigirInvitacionPendiente` estrecha a `{ status: 'INVITED' }` y pierde `id`. Para conservarlo, hacer la función genérica en `membresia.ts`:

```ts
export function exigirInvitacionPendiente<T extends { status: MembershipStatus }>(
  m: T | null,
): asserts m is T & { status: 'INVITED' } {
```

(y lo mismo con `exigirGestionable<T extends EstadoMembresia>`). Los tests de Task 4 siguen valiendo.

- [ ] **Step 4: Verlo pasar** — `npx vitest run src/modules/events` → PASS.

- [ ] **Step 5: Gates y commit**

```bash
npm run typecheck && npm run lint && npx prettier --check .
git add -A src/modules/events
git commit -m "feat: casos de uso para gestionar miembros y aceptar invitaciones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: rutas HTTP de miembros e invitaciones

**Files:**
- Create: `src/modules/events/interfaces/members.dto.ts`, `members.dto.test.ts`
- Create: `src/modules/events/interfaces/members.controller.ts`, `my-invitations.controller.ts`
- Modify: `src/modules/events/interfaces/events.controller.ts` (invitar = `OWNER`)
- Modify: `src/modules/events/events.module.ts`
- Modify: `test/e2e/event-access.e2e.test.ts`, `test/e2e/guests.e2e.test.ts` sólo si algún invitador no es el creador (revisar: hoy invita siempre el creador)
- Create: `test/e2e/members.e2e.test.ts`

**Interfaces:**
- Consumes: casos de uso de Task 5.
- Produces (HTTP, consumido por el frontend en Tasks 10–13):
  - `GET /events/:eventId/members` → `200 { items: Miembro[] }`
  - `PATCH /events/:eventId/members/:membershipId` body `{ role?: 'COUPLE'|'PLANNER', budgetAccess?: 'none'|'view' }` (al menos uno, `.strict()`) → `200 Miembro`
  - `DELETE /events/:eventId/members/:membershipId` → `204`
  - `POST /events/:eventId/members` → sin cambios salvo guard `OWNER`
  - `GET /me/invitations` → `200 { items: InvitacionPendiente[] }`
  - `POST /events/:eventId/invitation/accept` → `200 { eventId, status: 'ACTIVE' }`
  - `POST /events/:eventId/invitation/decline` → `204`

- [ ] **Step 1: DTO con test** — `members.dto.ts`:

```ts
import { z } from 'zod'

/**
 * `budgetAccess` sólo admite `none`/`view`: `edit` es del creador y no se
 * concede. `.strict()` para que un `{ status: 'ACTIVE' }` no se ignore en
 * silencio: aceptar tiene su propia ruta, la del invitado.
 */
export const updateMemberSchema = z
  .object({
    role: z.enum(['COUPLE', 'PLANNER']).optional(),
    budgetAccess: z.enum(['none', 'view']).optional(),
  })
  .strict()
  .refine((d) => d.role !== undefined || d.budgetAccess !== undefined, {
    message: 'Indica al menos un cambio',
  })
export type UpdateMemberDto = z.infer<typeof updateMemberSchema>
```

`members.dto.test.ts`:

```ts
import { updateMemberSchema } from './members.dto'

describe('updateMemberSchema', () => {
  it('acepta rol, nivel o ambos', () => {
    expect(updateMemberSchema.parse({ role: 'COUPLE' })).toEqual({ role: 'COUPLE' })
    expect(updateMemberSchema.parse({ budgetAccess: 'view' })).toEqual({ budgetAccess: 'view' })
  })

  it.each([{}, { budgetAccess: 'edit' }, { role: 'VENDOR' }, { status: 'ACTIVE' }])(
    'rechaza %o',
    (cuerpo) => {
      expect(updateMemberSchema.safeParse(cuerpo).success).toBe(false)
    },
  )
})
```

`npx vitest run src/modules/events/interfaces/members.dto.test.ts` → PASS tras crear el fichero.

- [ ] **Step 2: e2e que falla** — `test/e2e/members.e2e.test.ts`. Esqueleto igual que `budget-visibility.e2e.test.ts` (Postgres + Redis + `arrancarAppDeTest`, `registrarYEntrar` copiado de allí). Usuarios: `ana` (creadora), `luis`, `pia`, `extrano`. `evento = await crearEventoPublicado(url, ana.accessToken, 'Boda de Ana')`. Helpers:

```ts
  const auth = (u: { accessToken: string }) => ({ Authorization: `Bearer ${u.accessToken}` })

  async function invitar(email: string, role: 'COUPLE' | 'PLANNER'): Promise<string> {
    const r = await request(url).post(`/events/${evento}/members`).set(auth(ana)).send({ email, role }).expect(201)
    return (r.body as { id: string }).id
  }

  async function aceptar(u: { accessToken: string }): Promise<void> {
    await request(url).post(`/events/${evento}/invitation/accept`).set(auth(u)).expect(200)
  }
```

Casos (cada uno prepara lo suyo para correr aislado; usar emails nuevos por caso con `randomUUID()` cuando haga falta registrar a alguien más):

```ts
  it('invitar → aparece en /me/invitations → aceptar → entra al evento', async () => {
    await invitar('luis@test.com', 'COUPLE')
    const pendientes = await request(url).get('/me/invitations').set(auth(luis)).expect(200)
    expect((pendientes.body as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ eventId: evento, eventName: 'Boda de Ana', role: 'COUPLE', invitedByName: 'Ana' }),
    ])
    await request(url).get(`/events/${evento}`).set(auth(luis)).expect(404)

    const r = await request(url).post(`/events/${evento}/invitation/accept`).set(auth(luis)).expect(200)
    expect(r.body).toEqual({ eventId: evento, status: 'ACTIVE' })
    const ev = await request(url).get(`/events/${evento}`).set(auth(luis)).expect(200)
    expect(ev.body).toMatchObject({ budgetAccess: 'none', totalBudget: null })
    // Aceptar dos veces: la segunda no encuentra invitación.
    await request(url).post(`/events/${evento}/invitation/accept`).set(auth(luis)).expect(404)
  })

  it('rechazar: desaparece de pendientes y no da acceso', async () => {
    await invitar('pia@test.com', 'PLANNER')
    await request(url).post(`/events/${evento}/invitation/decline`).set(auth(pia)).expect(204)
    const pendientes = await request(url).get('/me/invitations').set(auth(pia)).expect(200)
    expect((pendientes.body as { items: unknown[] }).items).toEqual([])
    await request(url).get(`/events/${evento}`).set(auth(pia)).expect(404)
  })

  it('aceptar o rechazar sin invitación es 404, también en un evento inexistente', async () => {
    await request(url).post(`/events/${evento}/invitation/accept`).set(auth(extrano)).expect(404)
    await request(url).post(`/events/${randomUUID()}/invitation/decline`).set(auth(extrano)).expect(404)
  })

  it('la creadora lista, concede ver, cambia el rol y revoca', async () => {
    const u = await registrarYEntrar(`m-${randomUUID()}@test.com`, 'Marta')
    const id = await invitar(u.email, 'PLANNER')
    await aceptar(u)

    const lista = await request(url).get(`/events/${evento}/members`).set(auth(ana)).expect(200)
    const items = (lista.body as { items: Array<{ id: string; owner: boolean; budgetAccess: string }> }).items
    expect(items[0]).toMatchObject({ owner: true, budgetAccess: 'edit', fullName: 'Ana' })
    expect(items.find((m) => m.id === id)).toMatchObject({ budgetAccess: 'none', status: 'ACTIVE', role: 'PLANNER' })

    const concedido = await request(url)
      .patch(`/events/${evento}/members/${id}`).set(auth(ana)).send({ budgetAccess: 'view' }).expect(200)
    expect(concedido.body).toMatchObject({ id, budgetAccess: 'view' })
    await request(url).get(`/events/${evento}/budget-summary`).set(auth(u)).expect(200)

    const rol = await request(url)
      .patch(`/events/${evento}/members/${id}`).set(auth(ana)).send({ role: 'COUPLE' }).expect(200)
    expect(rol.body).toMatchObject({ role: 'COUPLE', budgetAccess: 'view' })

    await request(url).delete(`/events/${evento}/members/${id}`).set(auth(ana)).expect(204)
    await request(url).get(`/events/${evento}`).set(auth(u)).expect(404)
    await request(url).delete(`/events/${evento}/members/${id}`).set(auth(ana)).expect(404)

    // Reinvitada: nace sin grant.
    await invitar(u.email, 'PLANNER')
    await aceptar(u)
    const ev = await request(url).get(`/events/${evento}`).set(auth(u)).expect(200)
    expect(ev.body).toMatchObject({ budgetAccess: 'none' })
  })

  it('cancelar una invitación pendiente la quita de las del invitado', async () => {
    const u = await registrarYEntrar(`c-${randomUUID()}@test.com`, 'Cancelada')
    const id = await invitar(u.email, 'PLANNER')
    await request(url).delete(`/events/${evento}/members/${id}`).set(auth(ana)).expect(204)
    const pendientes = await request(url).get('/me/invitations').set(auth(u)).expect(200)
    expect((pendientes.body as { items: unknown[] }).items).toEqual([])
  })

  it('la creadora no puede tocarse a sí misma: 422', async () => {
    const lista = await request(url).get(`/events/${evento}/members`).set(auth(ana)).expect(200)
    const propia = (lista.body as { items: Array<{ id: string; owner: boolean }> }).items.find((m) => m.owner)
    await request(url).delete(`/events/${evento}/members/${propia?.id}`).set(auth(ana)).expect(422)
    await request(url)
      .patch(`/events/${evento}/members/${propia?.id}`).set(auth(ana)).send({ budgetAccess: 'none' }).expect(422)
    const ev = await request(url).get(`/events/${evento}`).set(auth(ana)).expect(200)
    expect(ev.body).toMatchObject({ budgetAccess: 'edit' })
  })

  it('sólo la creadora gestiona: un COUPLE y un PLANNER activos reciben 403, un extraño 404', async () => {
    const pareja = await registrarYEntrar(`p-${randomUUID()}@test.com`, 'Pareja')
    const planner = await registrarYEntrar(`pl-${randomUUID()}@test.com`, 'Planner')
    const idPlanner = await invitar(planner.email, 'PLANNER')
    await invitar(pareja.email, 'COUPLE')
    await aceptar(pareja)
    await aceptar(planner)

    for (const [u, esperado] of [[pareja, 403], [planner, 403], [extrano, 404]] as const) {
      await request(url).get(`/events/${evento}/members`).set(auth(u)).expect(esperado)
      await request(url)
        .post(`/events/${evento}/members`).set(auth(u)).send({ email: 'x@test.com', role: 'PLANNER' }).expect(esperado)
      await request(url)
        .patch(`/events/${evento}/members/${idPlanner}`).set(auth(u)).send({ budgetAccess: 'view' }).expect(esperado)
      await request(url).delete(`/events/${evento}/members/${idPlanner}`).set(auth(u)).expect(esperado)
    }
  })

  it('una membresía de otro evento es 404 aunque la pida su creadora', async () => {
    const otro = await crearEventoPublicado(url, ana.accessToken, 'Otra boda')
    const u = await registrarYEntrar(`o-${randomUUID()}@test.com`, 'Otro')
    const id = await invitar(u.email, 'PLANNER')
    await request(url).delete(`/events/${otro}/members/${id}`).set(auth(ana)).expect(404)
  })
```

`registrarYEntrar` debe devolver también el `email` (añadirlo al objeto). Ejecutar: `npx vitest run test/e2e/members.e2e.test.ts` → FAIL (rutas 404).

- [ ] **Step 3: Controladores** — `members.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common'

import { CurrentUser, type UsuarioAutenticado } from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { UnauthorizedError } from '@/shared/domain'
import { validarCon } from '@/shared/http/validar-con'

import {
  AcceptInvitationUseCase,
  DeclineInvitationUseCase,
  ListMembersUseCase,
  RevokeMemberUseCase,
  UpdateMemberUseCase,
  type Miembro,
} from '../application/members.use-cases'
import { EventAccessGuard } from './event-access.guard'
import { updateMemberSchema } from './members.dto'
import { RequireEventAccess } from './require-event-access.decorator'

function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}

/**
 * Gestión de miembros: sólo el creador (`OWNER`), igual que invitar. Aceptar
 * y rechazar van SIN `EventAccessGuard` a propósito: una membresía INVITED da
 * acceso `none` y el guard respondería 404 justo a quien tiene que entrar. El
 * caso de uso busca la INVITED del usuario autenticado y da el mismo 404 si no
 * la hay, así que no se revela nada que el guard no revelara.
 */
@UseGuards(JwtAuthGuard)
@Controller('events/:eventId')
export class MembersController {
  constructor(
    private readonly listar: ListMembersUseCase,
    private readonly actualizar: UpdateMemberUseCase,
    private readonly revocar: RevokeMemberUseCase,
    private readonly aceptar: AcceptInvitationUseCase,
    private readonly rechazar: DeclineInvitationUseCase,
  ) {}

  @UseGuards(EventAccessGuard)
  @RequireEventAccess('OWNER')
  @Get('members')
  async listarMiembros(@Param('eventId') eventId: string): Promise<{ items: Miembro[] }> {
    return { items: await this.listar.ejecutar(eventId) }
  }

  @UseGuards(EventAccessGuard)
  @RequireEventAccess('OWNER')
  @Patch('members/:membershipId')
  async actualizarMiembro(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ): Promise<Miembro> {
    const yo = exigirUsuario(usuario)
    const cambios = validarCon(updateMemberSchema, body)
    return await this.actualizar.ejecutar({ eventId, membershipId, actorId: yo.id, ...cambios })
  }

  @UseGuards(EventAccessGuard)
  @RequireEventAccess('OWNER')
  @Delete('members/:membershipId')
  @HttpCode(204)
  async revocarMiembro(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Param('membershipId') membershipId: string,
  ): Promise<void> {
    await this.revocar.ejecutar({ eventId, membershipId, actorId: exigirUsuario(usuario).id })
  }

  @Post('invitation/accept')
  @HttpCode(200)
  async aceptarInvitacion(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
  ): Promise<{ eventId: string; status: 'ACTIVE' }> {
    await this.aceptar.ejecutar(eventId, exigirUsuario(usuario).id)
    return { eventId, status: 'ACTIVE' }
  }

  @Post('invitation/decline')
  @HttpCode(204)
  async rechazarInvitacion(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
  ): Promise<void> {
    await this.rechazar.ejecutar(eventId, exigirUsuario(usuario).id)
  }
}
```

Si `:membershipId` o `:eventId` no son UUID, Prisma lanzaría un error de tipo de columna (500). Comprobar cómo trata el guard un `:eventId` mal formado (ver el `DESIGN-GAP` en `event-access.guard.ts:62`) y, para `:membershipId` y las rutas sin guard, validar con `z.uuid()` vía `validarCon` y responder 404 si no lo es (lanzar `MiembroNoEncontradoError` / `SinInvitacionPendienteError` en vez del 400, para no distinguir). Añadir un caso e2e: `DELETE /events/:evento/members/no-es-uuid` → 404 y `POST /events/no-es-uuid/invitation/accept` → 404.

`my-invitations.controller.ts`:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common'

import { CurrentUser, type UsuarioAutenticado } from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { UnauthorizedError } from '@/shared/domain'

import type { InvitacionPendiente } from '../application/event.repository'
import { ListMyInvitationsUseCase } from '../application/members.use-cases'

/** Invitaciones pendientes de quien tiene sesión: no cuelgan de ningún evento. */
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MyInvitationsController {
  constructor(private readonly listar: ListMyInvitationsUseCase) {}

  @Get('invitations')
  async misInvitaciones(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
  ): Promise<{ items: InvitacionPendiente[] }> {
    if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
    return { items: await this.listar.ejecutar(usuario.id) }
  }
}
```

`events.controller.ts` — en `invitarMiembro` cambiar `@RequireEventAccess('COUPLE')` por `@RequireEventAccess('OWNER')` y el docblock por:

```ts
  /**
   * Invitar es del creador (spec 2026-10-13): quien gestiona la lista de
   * miembros —rol, presupuesto, revocar— es él, y un segundo COUPLE que
   * invitara metería a gente que luego no podría gestionar.
   */
```

`events.module.ts` — añadir `MembersController` y `MyInvitationsController` a `controllers` y los seis casos de uso a `providers`.

- [ ] **Step 4: Verlo pasar** — `npx vitest run test/e2e/members.e2e.test.ts test/e2e/event-access.e2e.test.ts test/e2e/guests.e2e.test.ts` → PASS. Si `event-access.e2e` tiene un caso "un COUPLE no creador puede invitar", cambiarlo a 403 y renombrarlo.

- [ ] **Step 5: Gates y commit**

```bash
npm run typecheck && npm run lint && npx prettier --check .
git add -A src/modules/events test/e2e
git commit -m "feat: rutas para gestionar miembros y aceptar o rechazar invitaciones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: correo de invitación en su propia cola

**Files:**
- Modify: `src/modules/queue/application/queue.port.ts` (`QueueName`)
- Create: `src/modules/mail/application/member-invitation-renderer.port.ts`
- Create: `src/modules/mail/infrastructure/templates/member-invitation.tsx`, `member-invitation.test.ts`
- Modify: `src/modules/mail/mail.module.ts`
- Modify: `src/modules/events/application/invite-member.use-case.ts` (+ su test)
- Create: `src/modules/events/interfaces/member-invitation.processor.ts`, `member-invitation.processor.test.ts`
- Modify: `src/modules/events/events.module.ts`
- Modify: `src/modules/guests/application/send-invitations.use-case.ts:29` (comentario)

**Interfaces:**
- Produces:
  - `QueueName = 'email' | 'invitations' | 'notifications' | 'maintenance' | 'members'`
  - `export const COLA_MIEMBROS = 'members' satisfies QueueName` y `export interface PayloadInvitacionMiembro { membershipId: string; eventId: string; eventName: string; email: string; fullName: string; role: EventRole; invitedByName: string }` en `invite-member.use-case.ts`
  - Job `member-invitation` en la cola `members`, `jobId: event-invite-<membershipId>` (sin cambios)
  - `MemberInvitationRenderer.render({ fullName, invitedByName, eventName, role, appUrl }): Promise<{ html; text }>`, símbolo `MEMBER_INVITATION_RENDERER`

- [ ] **Step 1: Plantilla con test** — `member-invitation.test.ts`:

```ts
import { renderMemberInvitation } from './member-invitation'

describe('renderMemberInvitation', () => {
  const datos = {
    fullName: 'Pia',
    invitedByName: 'Ana',
    eventName: 'Boda de Ana',
    role: 'PLANNER' as const,
    appUrl: 'https://app.test/dashboard',
  }

  it('dice quién invita, a qué evento y con qué rol', async () => {
    const { text } = await renderMemberInvitation(datos)
    expect(text).toContain('Pia')
    expect(text).toContain('Ana')
    expect(text).toContain('Boda de Ana')
    expect(text.toLowerCase()).toContain('planner')
  })

  it('enlaza a la app, sin token: se acepta dentro, con sesión', async () => {
    const { html } = await renderMemberInvitation(datos)
    expect(html).toContain('https://app.test/dashboard')
    expect(html).not.toContain('token=')
  })
})
```

`member-invitation.tsx` (mismo estilo que `password-changed.tsx`):

```tsx
import { Body, Button, Container, Head, Heading, Html, Text } from '@react-email/components'
import { render } from '@react-email/components'

interface Props {
  fullName: string
  invitedByName: string
  eventName: string
  role: 'COUPLE' | 'PLANNER'
  appUrl: string
}

const ROL: Record<Props['role'], string> = { COUPLE: 'part of the couple', PLANNER: 'a planner' }

/**
 * Aviso, no enlace mágico: se acepta dentro de la app con la sesión de la
 * cuenta invitada (spec 2026-10-13 §2), así que el botón sólo lleva a ella.
 */
function MemberInvitation({ fullName, invitedByName, eventName, role, appUrl }: Props) {
  return (
    <Html lang="en">
      <Head />
      <Body style={{ fontFamily: 'Georgia, serif', backgroundColor: '#faf7f2' }}>
        <Container style={{ padding: '32px' }}>
          <Heading>You&apos;re invited to plan {eventName}</Heading>
          <Text>Hi {fullName},</Text>
          <Text>
            {invitedByName} invited you to join {eventName} as {ROL[role]}.
          </Text>
          <Text>Log in to accept or decline the invitation.</Text>
          <Button href={appUrl}>Log in to accept</Button>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderMemberInvitation(datos: Props): Promise<{ html: string; text: string }> {
  const elemento = <MemberInvitation {...datos} />
  return {
    html: await render(elemento),
    text: await render(elemento, { plainText: true }),
  }
}
```

(si `Button` de `@react-email/components` no está en la versión instalada, usar `Link` como `password-changed.tsx`). `npx vitest run src/modules/mail/infrastructure/templates/member-invitation.test.ts` → PASS.

- [ ] **Step 2: Puerto y cableado** — `member-invitation-renderer.port.ts`:

```ts
/**
 * Plantilla del aviso de invitación a un evento, publicada como puerto para
 * que el worker de `events` no importe `mail/infrastructure/` (regla
 * `modulos-no-se-tocan-las-tripas`). Mismo patrón que `INVITATION_RENDERER`.
 */
export interface MemberInvitationRenderer {
  render(datos: {
    fullName: string
    invitedByName: string
    eventName: string
    role: 'COUPLE' | 'PLANNER'
    appUrl: string
  }): Promise<{ html: string; text: string }>
}

export const MEMBER_INVITATION_RENDERER = Symbol('MEMBER_INVITATION_RENDERER')
```

En `mail.module.ts`: provider `{ provide: MEMBER_INVITATION_RENDERER, useValue: { render: renderMemberInvitation } satisfies MemberInvitationRenderer }` y exportarlo.

- [ ] **Step 3: Productor (test que falla)** — en `invite-member.use-case.test.ts`, cambiar el test "encola el correo…" a:

```ts
    expect(cola.encolados).toHaveLength(1)
    expect(cola.encolados[0]).toMatchObject({
      cola: 'members',
      nombre: 'member-invitation',
      datos: { email: 'pedro@test.com', fullName: 'Pedro', invitedByName: 'Ana', eventName: 'Boda de Ana', role: 'PLANNER' },
    })
```

→ FAIL. En `invite-member.use-case.ts`:

```ts
/**
 * Cola PROPIA de los avisos de invitación (ruling C17). Iban a `email`, cuyo
 * worker (`auth/interfaces/email.processor.ts`) descarta con
 * `UnrecoverableError` cualquier nombre que no conoce: el aviso se perdía.
 */
export const COLA_MIEMBROS = 'members' satisfies QueueName

export interface PayloadInvitacionMiembro {
  membershipId: string
  eventId: string
  eventName: string
  email: string
  fullName: string
  role: EventRole
  invitedByName: string
}
```

En `ejecutar`, antes de encolar: `const quienInvita = await this.usuarios.findById(datos.invitedById)` y encolar:

```ts
    await this.cola.enqueue<PayloadInvitacionMiembro>(
      COLA_MIEMBROS,
      'member-invitation',
      {
        membershipId: membresia.id,
        eventId: evento.id,
        eventName: evento.name,
        email: invitado.email,
        fullName: invitado.fullName,
        role: datos.role,
        // Sin cuenta (no debería pasar: lo autentica el guard) se firma con el evento.
        invitedByName: quienInvita?.fullName ?? evento.name,
      },
      { jobId: `event-invite-${membresia.id}` },
    )
```

El comentario `DESIGN-GAP` del `jobId` se conserva tal cual. `QueueName` en `queue.port.ts` gana `'members'` y su comentario añade "`members` (avisos de invitación a un evento)". En `guests/application/send-invitations.use-case.ts:29` sustituir "`event-invitation` de invitar miembros) sin worker todavía" por lo equivalente a "`member-invitation`, que tiene cola propia `members`)" manteniendo el sentido del párrafo (leerlo antes).

`npx vitest run src/modules/events/application/invite-member.use-case.test.ts` → PASS.

- [ ] **Step 4: Worker (test que falla)** — `member-invitation.processor.test.ts`:

```ts
import { UnrecoverableError, type Job } from 'bullmq'

import type { MemberInvitationRenderer } from '@/modules/mail/application/member-invitation-renderer.port'
import { FakeMailAdapter } from '@/modules/mail/infrastructure/mail.adapter.fake'

import { MemberInvitationProcessor } from './member-invitation.processor'

/** Doble LOCAL de la plantilla (regla `tests-solo-dobles-de-otros-modulos`). */
const plantilla: MemberInvitationRenderer = {
  render: (d) => Promise.resolve({ html: `<a href="${d.appUrl}">${d.eventName}</a>`, text: `${d.invitedByName} ${d.eventName}` }),
}

const PAYLOAD = {
  membershipId: 'm-1',
  eventId: 'e-1',
  eventName: 'Boda de Ana',
  email: 'pia@test.com',
  fullName: 'Pia',
  role: 'PLANNER',
  invitedByName: 'Ana',
}

describe('MemberInvitationProcessor', () => {
  let mail: FakeMailAdapter
  let procesador: MemberInvitationProcessor

  beforeEach(() => {
    mail = new FakeMailAdapter()
    procesador = new MemberInvitationProcessor(mail, { APP_URL: 'https://app.test' }, plantilla)
  })

  it('manda el aviso al invitado, enlazando a /dashboard, con clave por membresía', async () => {
    await procesador.process({ name: 'member-invitation', data: PAYLOAD } as Job)
    expect(mail.enviados).toEqual([
      expect.objectContaining({
        to: 'pia@test.com',
        subject: 'Ana invited you to Boda de Ana',
        html: '<a href="https://app.test/dashboard">Boda de Ana</a>',
        idempotencyKey: 'member-invitation-m-1',
      }),
    ])
  })

  it('un payload roto no se reintenta', async () => {
    await expect(
      procesador.process({ name: 'member-invitation', data: { email: 'x' } } as Job),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(mail.enviados).toEqual([])
  })

  it('un nombre de job desconocido no se reintenta', async () => {
    await expect(procesador.process({ name: 'otro', data: PAYLOAD } as Job)).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
  })
})
```

→ FAIL. `member-invitation.processor.ts`:

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import { z } from 'zod'

import { ENV } from '@/config/config.module'
import { MAIL_PORT, type MailPort } from '@/modules/mail/application/mail.port'
import {
  MEMBER_INVITATION_RENDERER,
  type MemberInvitationRenderer,
} from '@/modules/mail/application/member-invitation-renderer.port'

import { COLA_MIEMBROS, type PayloadInvitacionMiembro } from '../application/invite-member.use-case'

/** Lo que sale de Redis es entrada: se valida como cualquier otra frontera. */
const payloadSchema = z.object({
  membershipId: z.string().min(1),
  eventId: z.string().min(1),
  eventName: z.string().min(1),
  email: z.email(),
  fullName: z.string().min(1),
  role: z.enum(['COUPLE', 'PLANNER']),
  invitedByName: z.string().min(1),
}) satisfies z.ZodType<PayloadInvitacionMiembro>

/**
 * Worker del aviso de invitación a un evento. Cola PROPIA (`members`, ruling
 * C17), así que el único nombre válido es `member-invitation`; otro es un bug
 * del productor y no se reintenta.
 *
 * La clave de idempotencia es por membresía: un reintento de BullMQ no manda
 * un segundo correo. Reinvitar a la misma membresía dentro de las 24 h de
 * Resend tampoco lo manda: es el mismo `DESIGN-GAP` que el `jobId` de
 * `InviteMemberUseCase`, que esta clave no empeora.
 */
@Processor(COLA_MIEMBROS)
export class MemberInvitationProcessor extends WorkerHost {
  constructor(
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(ENV) private readonly env: { APP_URL: string },
    @Inject(MEMBER_INVITATION_RENDERER) private readonly plantilla: MemberInvitationRenderer,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'member-invitation') {
      throw new UnrecoverableError(`Job de tipo desconocido en la cola '${COLA_MIEMBROS}': ${job.name}`)
    }
    const leido = payloadSchema.safeParse(job.data)
    if (!leido.success) throw new UnrecoverableError('Payload de invitación a evento inválido')
    const d = leido.data

    const { html, text } = await this.plantilla.render({
      fullName: d.fullName,
      invitedByName: d.invitedByName,
      eventName: d.eventName,
      role: d.role,
      // `/dashboard` y no `/events/:id`: el invitado aún no tiene acceso, y
      // `/dashboard` le enseña sus invitaciones pendientes.
      appUrl: `${this.env.APP_URL}/dashboard`,
    })
    await this.mail.send({
      to: d.email,
      subject: `${d.invitedByName} invited you to ${d.eventName}`,
      html,
      text,
      tags: { membershipId: d.membershipId },
      idempotencyKey: `member-invitation-${d.membershipId}`,
    })
  }
}
```

`events.module.ts`: `imports` añade `MailModule` y `BullModule.registerQueue({ name: COLA_MIEMBROS })` (con el mismo comentario que en `guests.module.ts` sobre `NO_QUEUE_FOUND`); `providers` añade `MemberInvitationProcessor`. Comprobar que `MailModule` no importa `EventsModule` (ciclo) — no lo hace hoy.

- [ ] **Step 5: Verlo pasar** — `npx vitest run src/modules/events src/modules/mail test/e2e/members.e2e.test.ts` → PASS.

- [ ] **Step 6: Gates y commit**

```bash
npm run typecheck && npm run lint && npx prettier --check .
git add -A src/modules/events src/modules/mail src/modules/queue src/modules/guests/application/send-invitations.use-case.ts
git commit -m "feat: aviso por correo de la invitación a un evento, en su propia cola

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: matriz de acceso al presupuesto e2e

**Files:**
- Modify: `test/e2e/budget-visibility.e2e.test.ts`

**Interfaces:**
- Consumes: rutas de Task 6 (invitar/aceptar/PATCH), `budgetAccess` en `GET /events/:id`.

- [ ] **Step 1: Ampliar el `beforeAll`** — sustituir la creación a mano de las membresías de Luis y Pia por el flujo real (invitar → aceptar), y añadir dos usuarios: `lia` (COUPLE con grant) y `teo` (PLANNER con grant). Guardar los `membershipId` que devuelve el `POST /members`. Conceder `{ budgetAccess: 'view' }` con `PATCH` a Lia y Teo. Actualizar el comentario "Aún no hay flujo de aceptar invitación…" (ya lo hay).

```ts
    for (const [u, role] of [[luis, 'COUPLE'], [pia, 'PLANNER'], [lia, 'COUPLE'], [teo, 'PLANNER']] as const) {
      const r = await request(url)
        .post(`/events/${evento}/members`).set({ Authorization: `Bearer ${ana.accessToken}` })
        .send({ email: u.email, role }).expect(201)
      membresias.set(u.id, (r.body as { id: string }).id)
      await request(url)
        .post(`/events/${evento}/invitation/accept`).set({ Authorization: `Bearer ${u.accessToken}` }).expect(200)
    }
    for (const u of [lia, teo]) {
      await request(url)
        .patch(`/events/${evento}/members/${membresias.get(u.id)}`)
        .set({ Authorization: `Bearer ${ana.accessToken}` })
        .send({ budgetAccess: 'view' }).expect(200)
    }
```

(`registrarYEntrar` devuelve también `email`).

- [ ] **Step 2: Casos nuevos** — la matriz que el spec pide (creador ya cubierto; COUPLE/PLANNER sin permiso, proveedor y extraño ya cubiertos — renombrar sus títulos a "… sin permiso"). Añadir:

```ts
  it.each([
    ['COUPLE no creador con permiso', () => lia],
    ['PLANNER con permiso', () => teo],
  ])('%s lee gastos, resumen e importes, y recibe 403 al escribir', async (_quien, usuario) => {
    const gasto = await crearGastoDeAna()
    const auth = { Authorization: `Bearer ${usuario().accessToken}` }
    await request(url).get(`/events/${evento}/expenses`).set(auth).expect(200)
    await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(200)
    await request(url)
      .post(`/events/${evento}/expenses`).set(auth)
      .send({ concept: 'X', category: 'Y', amount: '1', payeeName: 'Z' }).expect(403)
    await request(url).patch(`/events/${evento}/expenses/${gasto}`).set(auth).send({ status: 'PAID' }).expect(403)
    await request(url).delete(`/events/${evento}/expenses/${gasto}`).set(auth).expect(403)

    const ev = await request(url).get(`/events/${evento}`).set(auth).expect(200)
    expect(ev.body).toMatchObject({ totalBudget: '30000.00', budgetAccess: 'view' })
    const lista = await request(url).get('/events').set(auth).expect(200)
    expect(
      (lista.body as Array<{ id: string; totalBudget: string | null }>).find((e) => e.id === evento)?.totalBudget,
    ).toBe('30000.00')
    const vendors = await request(url).get(`/events/${evento}/vendors`).set(auth).expect(200)
    expect((vendors.body as Array<{ assignedBudget: string | null }>)[0]?.assignedBudget).toBe('500.00')
  })

  it('retirar el permiso corta la lectura en la siguiente petición', async () => {
    const u = await registrarYEntrar(`r-${randomUUID()}@test.com`, 'Retirada')
    const r = await request(url)
      .post(`/events/${evento}/members`).set({ Authorization: `Bearer ${ana.accessToken}` })
      .send({ email: u.email, role: 'PLANNER' }).expect(201)
    const id = (r.body as { id: string }).id
    await request(url).post(`/events/${evento}/invitation/accept`).set({ Authorization: `Bearer ${u.accessToken}` }).expect(200)
    const patch = (budgetAccess: 'view' | 'none') =>
      request(url).patch(`/events/${evento}/members/${id}`)
        .set({ Authorization: `Bearer ${ana.accessToken}` }).send({ budgetAccess }).expect(200)

    await patch('view')
    await request(url).get(`/events/${evento}/budget-summary`).set({ Authorization: `Bearer ${u.accessToken}` }).expect(200)
    await patch('none')
    await request(url).get(`/events/${evento}/budget-summary`).set({ Authorization: `Bearer ${u.accessToken}` }).expect(403)
  })

  it('el extraño no ve el evento ni con un grant ajeno en la base', async () => {
    await request(url).get(`/events/${evento}`).set({ Authorization: `Bearer ${extrano.accessToken}` }).expect(404)
    const lista = await request(url).get('/events').set({ Authorization: `Bearer ${extrano.accessToken}` }).expect(200)
    expect((lista.body as Array<{ id: string }>).map((e) => e.id)).not.toContain(evento)
  })
```

(importar `randomUUID` de `node:crypto`).

- [ ] **Step 3: Verlo pasar** — `npx vitest run test/e2e/budget-visibility.e2e.test.ts` → PASS.

- [ ] **Step 4: Suite completa y commit**

```bash
npm test && npm run typecheck && npm run lint && npx prettier --check . && npm run build && npm run test:smoke
git add test/e2e/budget-visibility.e2e.test.ts
git commit -m "test: matriz de acceso al presupuesto con y sin permiso concedido

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: PR del backend

- [ ] **Step 1:** `git push -u origin feat/miembros-presupuesto`
- [ ] **Step 2:** `gh pr create --base develop --title "Miembros del evento y permiso de ver el presupuesto" --body "<resumen: tabla event_budget_grants, rutas de miembros, aceptar/rechazar, cola members, matriz e2e; enlace al spec; '🤖 Generated with [Claude Code](https://claude.com/claude-code)'>"`. Pedir confirmación al usuario antes de crear el PR.

---

## Frontend

Todas las tareas en `wedding-planner-frontend`.

### Task 10: modelo y API de miembros

**Files:**
- Create: `src/features/members/members-model.ts`, `src/features/members/members-api.ts`, `src/features/members/members-api.test.ts`
- Modify: `src/features/event-config/errors.ts` (códigos nuevos)

**Interfaces:**
- Produces:

```ts
// members-model.ts
export const memberRoleSchema = z.enum(['COUPLE', 'PLANNER'])
export type MemberRole = z.infer<typeof memberRoleSchema>
export const memberSchema = z.object({
  id: z.string(), userId: z.string(), fullName: z.string(), email: z.string(),
  role: memberRoleSchema, status: z.enum(['INVITED', 'ACTIVE']), owner: z.boolean(),
  budgetAccess: budgetAccessSchema,
})
export type Member = z.infer<typeof memberSchema>
export const invitationSchema = z.object({
  membershipId: z.string(), eventId: z.string(), eventName: z.string(),
  role: memberRoleSchema, invitedByName: z.string().nullable(),
})
export type Invitation = z.infer<typeof invitationSchema>
export interface MemberChanges { role?: MemberRole; budgetAccess?: 'none' | 'view' }

// members-api.ts
listMembers(eventId: string): Promise<Member[]>
inviteMember(eventId: string, input: { email: string; role: MemberRole }): Promise<void>
updateMember(eventId: string, membershipId: string, changes: MemberChanges): Promise<Member>
revokeMember(eventId: string, membershipId: string): Promise<void>
listMyInvitations(): Promise<Invitation[]>
acceptInvitation(eventId: string): Promise<void>
declineInvitation(eventId: string): Promise<void>
```

- [ ] **Step 0: Rama** — `git switch develop && git pull && git switch -c feat/miembros-presupuesto`.

- [ ] **Step 1: Test que falla** — `members-api.test.ts` (mockear `../../lib/api-client` como en `event-api.test.ts`; leerlo primero para copiar el patrón exacto):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn() }))
vi.mock('../../lib/api-client', () => client)

import {
  acceptInvitation,
  declineInvitation,
  inviteMember,
  listMembers,
  listMyInvitations,
  revokeMember,
  updateMember,
} from './members-api'

const member = {
  id: 'm-1', userId: 'u-1', fullName: 'Pia', email: 'pia@test.com',
  role: 'PLANNER', status: 'ACTIVE', owner: false, budgetAccess: 'none',
}

describe('members-api', () => {
  beforeEach(() => vi.resetAllMocks())

  it('lista miembros validando la respuesta', async () => {
    client.apiGet.mockResolvedValue({ items: [member] })
    expect(await listMembers('ev 1')).toEqual([member])
    expect(client.apiGet).toHaveBeenCalledWith('/events/ev%201/members')
  })

  it('rechaza una respuesta con forma inesperada', async () => {
    client.apiGet.mockResolvedValue({ items: [{ ...member, budgetAccess: 'admin' }] })
    await expect(listMembers('ev-1')).rejects.toThrow()
  })

  it('invita, actualiza y revoca en sus rutas', async () => {
    client.apiPatch.mockResolvedValue({ ...member, budgetAccess: 'view' })
    await inviteMember('ev-1', { email: 'pia@test.com', role: 'PLANNER' })
    expect(client.apiPost).toHaveBeenCalledWith('/events/ev-1/members', { email: 'pia@test.com', role: 'PLANNER' })
    expect(await updateMember('ev-1', 'm-1', { budgetAccess: 'view' })).toMatchObject({ budgetAccess: 'view' })
    expect(client.apiPatch).toHaveBeenCalledWith('/events/ev-1/members/m-1', { budgetAccess: 'view' })
    await revokeMember('ev-1', 'm-1')
    expect(client.apiDelete).toHaveBeenCalledWith('/events/ev-1/members/m-1')
  })

  it('invitaciones propias: listar, aceptar y rechazar', async () => {
    const inv = { membershipId: 'm-1', eventId: 'ev-1', eventName: 'Boda', role: 'COUPLE', invitedByName: null }
    client.apiGet.mockResolvedValue({ items: [inv] })
    expect(await listMyInvitations()).toEqual([inv])
    expect(client.apiGet).toHaveBeenCalledWith('/me/invitations')
    await acceptInvitation('ev-1')
    expect(client.apiPost).toHaveBeenCalledWith('/events/ev-1/invitation/accept', {})
    await declineInvitation('ev-1')
    expect(client.apiPost).toHaveBeenCalledWith('/events/ev-1/invitation/decline', {})
  })
})
```

`npx vitest run src/features/members/members-api.test.ts` → FAIL.

- [ ] **Step 2: Implementar** — `members-model.ts` con los esquemas de "Interfaces" (importar `budgetAccessSchema` de `../event-config/event-model`; docblock: "Respuestas de `/events/:id/members` y `/me/invitations`, validadas al llegar"). `members-api.ts`:

```ts
import { z } from 'zod'
import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api-client'
import { invitationSchema, memberSchema, type Invitation, type Member, type MemberChanges, type MemberRole } from './members-model'

/**
 * Miembros de un evento (sólo el creador: la API responde 403 a los demás) e
 * invitaciones propias. Las respuestas se validan con zod, como en `event-api.ts`.
 */
const members = (eventId: string) => `/events/${encodeURIComponent(eventId)}/members`
const invitation = (eventId: string) => `/events/${encodeURIComponent(eventId)}/invitation`

export async function listMembers(eventId: string): Promise<Member[]> {
  return z.object({ items: z.array(memberSchema) }).parse(await apiGet(members(eventId))).items
}

export async function inviteMember(eventId: string, input: { email: string; role: MemberRole }): Promise<void> {
  await apiPost(members(eventId), input)
}

export async function updateMember(eventId: string, membershipId: string, changes: MemberChanges): Promise<Member> {
  return memberSchema.parse(await apiPatch(`${members(eventId)}/${encodeURIComponent(membershipId)}`, changes))
}

export async function revokeMember(eventId: string, membershipId: string): Promise<void> {
  await apiDelete(`${members(eventId)}/${encodeURIComponent(membershipId)}`)
}

export async function listMyInvitations(): Promise<Invitation[]> {
  return z.object({ items: z.array(invitationSchema) }).parse(await apiGet('/me/invitations')).items
}

export async function acceptInvitation(eventId: string): Promise<void> {
  await apiPost(`${invitation(eventId)}/accept`, {})
}

export async function declineInvitation(eventId: string): Promise<void> {
  await apiPost(`${invitation(eventId)}/decline`, {})
}
```

En `errors.ts`, dentro del `switch` de `errorMessage`:

```ts
    case 'INVITEE_HAS_NO_ACCOUNT':
      return 'This person needs an account first. Ask them to sign up, then invite them again.'
    case 'ALREADY_MEMBER':
      return 'Already a member of this event, or already invited.'
    case 'OWNER_MEMBERSHIP_IMMUTABLE':
      return 'The event creator can’t be changed or removed.'
    case 'MEMBER_NOT_FOUND':
      return 'This member is no longer part of the event.'
    case 'NO_PENDING_INVITATION':
      return 'This invitation is no longer available.'
```

y un test por cada uno en `errors.test.ts` (copiar el patrón existente con `new ApiRequestError(422, { code, message })`).

- [ ] **Step 3: Verlo pasar** — `npx vitest run src/features/members src/features/event-config/errors.test.ts` → PASS.

- [ ] **Step 4: Commit**

```bash
npm run typecheck && npm run lint
git add src/features/members src/features/event-config/errors.ts src/features/event-config/errors.test.ts
git commit -m "feat: API de miembros e invitaciones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: invitaciones pendientes (store, selector y `/dashboard`)

**Files:**
- Create: `src/lib/invitations-store.ts`, `src/lib/invitations-store.test.ts`
- Create: `src/features/members/pending-invitations.tsx`, `pending-invitations.test.tsx`
- Modify: `src/app/event-switcher.tsx` (+test), `src/app/app-layout.tsx` (+test), `src/app/dashboard-redirect.tsx` (+test)

**Interfaces:**
- Consumes: `listMyInvitations`, `acceptInvitation`, `declineInvitation` (Task 10); `useEventsStore().reload`.
- Produces:

```ts
// invitations-store.ts
export interface InvitationsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  invitations: Invitation[]
  load: () => Promise<void>       // no repite una lista ya cargada
  reload: () => Promise<void>
  accept: (eventId: string) => Promise<void>   // quita la invitación, recarga eventos; si la API da 404 también la quita y NO relanza
  decline: (eventId: string) => Promise<void>  // ídem
  clear: () => void
}
export const useInvitationsStore
// pending-invitations.tsx
export interface PendingInvitationsProps { invitations: Invitation[]; onAccept: (eventId: string) => Promise<void>; onDecline: (eventId: string) => Promise<void> }
export function PendingInvitations(props): JSX.Element
// event-switcher.tsx: props nuevas
invitations: Invitation[]
onAccept: (eventId: string) => void
onDecline: (eventId: string) => void
```

- [ ] **Step 1: Store (test que falla)** — `invitations-store.test.ts` (mockear `../features/members/members-api` y `./events-store`):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from './api-client'

const api = vi.hoisted(() => ({ listMyInvitations: vi.fn(), acceptInvitation: vi.fn(), declineInvitation: vi.fn() }))
vi.mock('../features/members/members-api', () => api)
const reloadEvents = vi.hoisted(() => vi.fn())
vi.mock('./events-store', () => ({ useEventsStore: { getState: () => ({ reload: reloadEvents }) } }))

import { useInvitationsStore } from './invitations-store'

const inv = (eventId: string) => ({ membershipId: `m-${eventId}`, eventId, eventName: eventId, role: 'COUPLE' as const, invitedByName: 'Ana' })

describe('invitations-store', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    useInvitationsStore.getState().clear()
  })

  it('carga una vez y guarda la lista', async () => {
    api.listMyInvitations.mockResolvedValue([inv('a')])
    await useInvitationsStore.getState().load()
    await useInvitationsStore.getState().load()
    expect(api.listMyInvitations).toHaveBeenCalledOnce()
    expect(useInvitationsStore.getState()).toMatchObject({ status: 'ready', invitations: [inv('a')] })
  })

  it('aceptar quita la invitación y recarga los eventos', async () => {
    api.listMyInvitations.mockResolvedValue([inv('a'), inv('b')])
    await useInvitationsStore.getState().load()
    await useInvitationsStore.getState().accept('a')
    expect(api.acceptInvitation).toHaveBeenCalledWith('a')
    expect(useInvitationsStore.getState().invitations).toEqual([inv('b')])
    expect(reloadEvents).toHaveBeenCalledOnce()
  })

  it('aceptar una que ya no existe (404) la quita igualmente sin lanzar', async () => {
    api.listMyInvitations.mockResolvedValue([inv('a')])
    api.acceptInvitation.mockRejectedValue(new ApiRequestError(404, { code: 'NO_PENDING_INVITATION', message: 'x' }))
    await useInvitationsStore.getState().load()
    await expect(useInvitationsStore.getState().accept('a')).resolves.toBeUndefined()
    expect(useInvitationsStore.getState().invitations).toEqual([])
    expect(reloadEvents).toHaveBeenCalledOnce()
  })

  it('otro error se relanza y la invitación se queda', async () => {
    api.listMyInvitations.mockResolvedValue([inv('a')])
    api.declineInvitation.mockRejectedValue(new ApiRequestError(500, { code: 'UNKNOWN', message: 'x' }))
    await useInvitationsStore.getState().load()
    await expect(useInvitationsStore.getState().decline('a')).rejects.toThrow()
    expect(useInvitationsStore.getState().invitations).toEqual([inv('a')])
  })
})
```

→ FAIL.

- [ ] **Step 2: Store** — `invitations-store.ts`, mismo patrón que `events-store.ts` (contador `generacion`, suscripción a `useAuthStore` que hace `clear()` al cambiar de usuario):

```ts
import { create } from 'zustand'
import { acceptInvitation, declineInvitation, listMyInvitations } from '../features/members/members-api'
import type { Invitation } from '../features/members/members-model'
import { ApiRequestError } from './api-client'
import { useAuthStore } from './auth-store'
import { useEventsStore } from './events-store'

/**
 * Invitaciones pendientes de quien tiene sesión: las usan el selector de
 * eventos y `/dashboard`. Mismo contrato que `events-store` (lista atada a la
 * sesión, `generacion` descarta respuestas viejas). Aceptar o rechazar quita
 * la invitación y recarga los eventos; un 404 significa que ya no está (otra
 * pestaña, doble clic), así que se trata como hecho y no como error.
 */
export interface InvitationsState { /* …como en Interfaces… */ }

let generacion = 0

async function resolver(
  set: (p: Partial<InvitationsState>) => void,
  get: () => InvitationsState,
  eventId: string,
  llamada: (eventId: string) => Promise<void>,
): Promise<void> {
  try {
    await llamada(eventId)
  } catch (error) {
    if (!(error instanceof ApiRequestError && error.status === 404)) throw error
  }
  set({ invitations: get().invitations.filter((i) => i.eventId !== eventId) })
  await useEventsStore.getState().reload()
}

export const useInvitationsStore = create<InvitationsState>((set, get) => ({
  status: 'idle',
  invitations: [],
  load: async () => {
    const { status } = get()
    if (status === 'ready' || status === 'loading') return
    await get().reload()
  },
  reload: async () => {
    const mia = ++generacion
    set({ status: 'loading' })
    try {
      const invitations = await listMyInvitations()
      if (mia === generacion) set({ status: 'ready', invitations })
    } catch {
      if (mia === generacion) set({ status: 'error' })
    }
  },
  accept: (eventId) => resolver(set, get, eventId, acceptInvitation),
  decline: (eventId) => resolver(set, get, eventId, declineInvitation),
  clear: () => {
    generacion++
    set({ status: 'idle', invitations: [] })
  },
}))

useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) useInvitationsStore.getState().clear()
})
```

→ PASS.

- [ ] **Step 3: `PendingInvitations` (test que falla, luego componente)** — test:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiRequestError } from '../../lib/api-client'
import { PendingInvitations } from './pending-invitations'

const inv = { membershipId: 'm-1', eventId: 'ev-1', eventName: 'Boda de Ana', role: 'PLANNER' as const, invitedByName: 'Ana' }

describe('PendingInvitations', () => {
  it('muestra evento, rol y quién invita, y acepta', async () => {
    const onAccept = vi.fn().mockResolvedValue(undefined)
    render(<PendingInvitations invitations={[inv]} onAccept={onAccept} onDecline={vi.fn()} />)
    expect(screen.getByText('Boda de Ana')).toBeInTheDocument()
    expect(screen.getByText(/Ana invited you as planner/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation to Boda de Ana' }))
    expect(onAccept).toHaveBeenCalledWith('ev-1')
  })

  it('rechaza y enseña el error si falla', async () => {
    const onDecline = vi.fn().mockRejectedValue(new ApiRequestError(500, { code: 'UNKNOWN', message: 'x' }))
    render(<PendingInvitations invitations={[inv]} onAccept={vi.fn()} onDecline={onDecline} />)
    await userEvent.click(screen.getByRole('button', { name: 'Decline invitation to Boda de Ana' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t update the invitation/i)
  })
})
```

Componente `pending-invitations.tsx`: una `Card` por invitación con el nombre del evento (`font-bold`), la línea `{invitedByName ?? 'Someone'} invited you as {role === 'COUPLE' ? 'part of the couple' : 'planner'}` y dos `Button` (`size="sm"`; Accept `variant="primary"`, Decline `variant="ghost"`) con `aria-label` "Accept invitation to {eventName}" / "Decline invitation to {eventName}" y `loading` mientras su promesa está en vuelo. Error con `errorMessage(e, "We couldn't update the invitation. Please try again.")` en un `<p role="alert">`. Sin valores arbitrarios de Tailwind.

- [ ] **Step 4: Selector** — en `event-switcher.test.tsx` añadir `invitations={[]} onAccept={vi.fn()} onDecline={vi.fn()}` a los renders existentes y:

```tsx
  it('lista las invitaciones encima de los eventos y acepta o rechaza', async () => {
    const onAccept = vi.fn()
    const onDecline = vi.fn()
    const inv = { membershipId: 'm', eventId: 'ev-9', eventName: 'Boda de Pia', role: 'COUPLE' as const, invitedByName: 'Pia' }
    render(<EventSwitcher events={events} currentEventId={undefined} onSelect={vi.fn()} onCreate={vi.fn()}
      invitations={[inv]} onAccept={onAccept} onDecline={onDecline} />)
    // El disparador avisa de que hay algo pendiente.
    await userEvent.click(screen.getByRole('button', { name: 'Select event (1 pending invitation)' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Accept invitation to Boda de Pia' }))
    expect(onAccept).toHaveBeenCalledWith('ev-9')
    await userEvent.click(screen.getByRole('button', { name: 'Select event (1 pending invitation)' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Decline invitation to Boda de Pia' }))
    expect(onDecline).toHaveBeenCalledWith('ev-9')
  })
```

En `event-switcher.tsx`: props nuevas; si hay invitaciones, el `aria-label` del disparador añade ` (N pending invitation[s])` y se pinta un `Badge` con N junto al nombre; dentro del menú, antes de los eventos, un encabezado "Invitations" (`<p className="px-2 pb-1 text-2xs font-bold uppercase tracking-caps text-ink/60">` o el `DropdownMenuLabel` si existe en `dropdown-menu.tsx`) y, por invitación, dos `DropdownMenuItem`: "Accept invitation to {eventName}" y "Decline invitation to {eventName}" que llaman a `onAccept`/`onDecline`; luego un separador si existe la primitiva. Actualizar el docblock.

- [ ] **Step 5: Layout** — en `app-layout.tsx`: `const invitations = useInvitationsStore((s) => s.invitations)`, `load` en el mismo `useEffect` que `loadEvents`, y al switcher:

```tsx
            invitations={invitations}
            onAccept={(id) =>
              void useInvitationsStore.getState().accept(id).then(
                () => navigate(`/events/${encodeURIComponent(id)}/dashboard`),
                () => undefined, // el error lo enseña `/dashboard`; aquí no hay sitio
              )
            }
            onDecline={(id) => void useInvitationsStore.getState().decline(id).catch(() => undefined)}
```

En `app-layout.test.tsx`, mockear `../features/members/members-api` (`listMyInvitations` → `[]` por defecto) y añadir un test: con una invitación, aceptar desde el selector navega a `/events/ev-9/dashboard`.

- [ ] **Step 6: `/dashboard` sin eventos** — test nuevo en `dashboard-redirect.test.tsx`:

```tsx
  it('sin eventos pero con invitaciones, las enseña en vez de mandar a crear uno', async () => {
    // eventos: [] ; invitaciones: [inv]
    ...
    expect(await screen.findByText('Boda de Pia')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create an event instead' })).toBeInTheDocument()
  })

  it('sin eventos ni invitaciones sigue mandando a /events/new', async () => { ... })

  it('si las invitaciones fallan al cargar, no bloquea: manda a /events/new', async () => { ... })
```

(leer el test existente para el patrón de montaje con router y de siembra de los stores; sembrar `useInvitationsStore.setState({ status: 'ready', invitations: [...] })`).

En `dashboard-redirect.tsx`: leer `useInvitationsStore` (`status`, `invitations`, `load`, `accept`, `decline`) y llamar a `load` en el `useEffect`. Tras el bloque de error de eventos: si `events.length === 0` y el estado de invitaciones es `idle`/`loading` → el mismo "Loading your events…"; si es `ready` con invitaciones → `<main>` con título "You have pending invitations", `<PendingInvitations invitations onAccept={async (id) => { await accept(id); void navigate(`/events/${encodeURIComponent(id)}/dashboard`) }} onDecline={decline} />` y `Button variant="outline"` "Create an event instead" → `navigate('/events/new')`. En cualquier otro caso, la redirección de siempre. Actualizar el docblock.

- [ ] **Step 7: Verlo pasar y commit**

```bash
npx vitest run src/lib/invitations-store.test.ts src/features/members src/app
npm run typecheck && npm run lint
git add src/lib/invitations-store.ts src/lib/invitations-store.test.ts src/features/members src/app
git commit -m "feat: aceptar o rechazar invitaciones desde el selector y /dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: sección Members en Event Settings

**Files:**
- Create: `src/features/members/use-members.ts` (+test), `members-list.tsx` (+test), `invite-member-form.tsx` (+test), `revoke-member-modal.tsx`, `members-section.tsx` (+test)
- Modify: `src/features/settings/event-settings-screen.tsx` (+test)

**Interfaces:**
- Consumes: `listMembers`, `inviteMember`, `updateMember`, `revokeMember` (Task 10), `errorMessage`.
- Produces:

```ts
// use-members.ts
export interface UseMembers {
  state: { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; members: Member[] }
  error: string | null          // último fallo de una mutación (role="alert")
  retry: () => void
  invite: (input: { email: string; role: MemberRole }) => Promise<void>  // relanza: el formulario enseña su error
  setRole: (id: string, role: MemberRole) => Promise<void>              // optimista + revertir
  setBudgetView: (id: string, view: boolean) => Promise<void>           // optimista + revertir
  revoke: (id: string) => Promise<void>                                 // relanza: el modal enseña su error
}
export function useMembers(eventId: string): UseMembers
// members-list.tsx
export interface MembersListProps {
  members: Member[]
  variant: 'full' | 'budget'
  onRoleChange?: (id: string, role: MemberRole) => void
  onBudgetChange: (id: string, view: boolean) => void
  onRevoke?: (member: Member) => void
}
// invite-member-form.tsx
export interface InviteMemberFormProps { onInvite: (input: { email: string; role: MemberRole }) => Promise<void> }
// members-section.tsx
export function MembersSection({ eventId }: { eventId: string }): JSX.Element
```

- [ ] **Step 1: `useMembers` (test que falla)** — con `renderHook` y `members-api` mockeado:
  - carga → `ready` con la lista;
  - `setBudgetView('m-2', true)` cambia el miembro a `budgetAccess: 'view'` ANTES de que resuelva la API (comprobar con una promesa pendiente) y lo deja con lo que devuelve la API;
  - si `updateMember` rechaza, vuelve a `'none'` y `error` = mensaje de `errorMessage`;
  - `setRole` igual;
  - `invite` llama a `inviteMember` y recarga la lista; si rechaza, relanza y no recarga;
  - `revoke` quita al miembro de la lista tras resolver; si rechaza, relanza y la lista no cambia.

Implementar con `useState` + `useEffect` (con bandera `cancelled`, como `EventSettingsScreen`) y `useCallback` para cada mutación. Para la carrera de dos interruptores seguidos, aplicar el cambio optimista con `setState(prev => …)` y revertir sólo el campo tocado del miembro tocado (no restaurar la lista entera).

- [ ] **Step 2: `MembersList` (test que falla)** — casos:
  - `variant="full"`: por miembro, avatar (`Avatar alt={fullName} name={fullName}`), nombre, email, `Select` "Role for {fullName}" (COUPLE→"Couple", PLANNER→"Planner"), `Switch` "Can view budget: {fullName}" y botón "Remove {fullName}" (o "Cancel invitation for {fullName}" si `status === 'INVITED'`), y `Badge` "Pending" en las INVITED;
  - la fila del creador: `Badge` "Owner", sin select ni botón, y el switch marcado y `disabled`;
  - cambiar el select llama a `onRoleChange('m-2', 'COUPLE')`; pulsar el switch llama a `onBudgetChange('m-2', true)`; pulsar "Remove" llama a `onRevoke(member)`;
  - `variant="budget"`: sólo nombre y switch (ni select, ni email, ni botón).

Implementar como lista (`<ul>`, un `<li>` por miembro con `flex items-center gap-4`), con primitivas `Avatar`, `Badge`, `Select`, `Switch`, `Button variant="ghost" size="sm"`.

- [ ] **Step 3: `InviteMemberForm` (test que falla)** — casos:
  - email vacío o inválido → no llama y enseña "Enter a valid email";
  - envía `{ email, role }` (rol por defecto `PLANNER`), deshabilita mientras está en vuelo y limpia el email al terminar;
  - si `onInvite` rechaza con `ApiRequestError(422, { code: 'INVITEE_HAS_NO_ACCOUNT' })`, enseña "This person needs an account first…" en `role="alert"` y conserva el email.

Implementar con `useValidatedForm` (`src/lib/use-validated-form.ts`; leerlo) y un esquema zod `{ email: z.email('Enter a valid email'), role: z.enum(['COUPLE','PLANNER']) }`, `FormField` + `Input` + `Select` + `Button type="submit"` "Send invitation".

- [ ] **Step 4: `RevokeMemberModal`** — copia de `budget/delete-expense-modal.tsx` con `member: Member | null`: título "Remove {fullName}?" (INVITED: "Cancel invitation for {fullName}?"), descripción "They will lose access to this event." / "The invitation will be withdrawn.", botón "Remove member" / "Cancel invitation"; el error de la API en `role="alert"`. Se prueba a través de `MembersSection`.

- [ ] **Step 5: `MembersSection` (test que falla)** — con `members-api` mockeado: título "Members" y texto "Invite people to plan this event and choose who can see the budget."; formulario arriba, lista debajo; "Remove Pia" → modal → "Remove member" → `revokeMember('ev-1','m-2')` y Pia desaparece; error de carga → "We couldn't load the members." + "Try Again". Implementar como `<section aria-labelledby>` dentro de una `Card padding="lg"`, ensamblando `useMembers`, `InviteMemberForm`, `MembersList variant="full"` y `RevokeMemberModal`.

- [ ] **Step 6: Settings** — en `event-settings-screen.tsx`, cuando `state.kind === 'ready'`, montar `<MembersSection eventId={eventId} />` DESPUÉS del cierre de `GeneralInfoForm` (fuera de su `<form>`: un formulario anidado es HTML inválido y su submit llegaría al de Settings), con `className="mt-10"` en el contenedor. En `event-settings-screen.test.tsx`, mockear `../members/members-api` y añadir: "el creador ve la sección Members con sus miembros".

- [ ] **Step 7: Verlo pasar y commit**

```bash
npx vitest run src/features/members src/features/settings
npm run typecheck && npm run lint
git add src/features/members src/features/settings
git commit -m "feat: sección Members en Event Settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: botón Share en Budget y modo «Ver»

**Files:**
- Create: `src/features/members/share-budget-modal.tsx` (+test)
- Modify: `src/features/budget/budget-screen.tsx` (+test)
- Modify: `src/features/dashboard/dashboard-screen.test.tsx`, `src/features/event-vendors/event-vendors-screen.test.tsx`, `src/app/app-layout.test.tsx`

**Interfaces:**
- Consumes: `useMembers`, `MembersList variant="budget"` (Task 12).
- Produces: `ShareBudgetModal({ eventId, open, onOpenChange })`.

- [ ] **Step 1: Modal (test que falla)** — con `members-api` mockeado: abierto, título "Share budget", descripción "Choose who can see expenses, the budget summary and vendor amounts. Only you can edit them."; lista con los miembros que no son el creador; el switch de Pia llama a `updateMember('ev-1','m-2',{ budgetAccess: 'view' })`; enlace "Manage members" con `href="/events/ev-1/settings"`; si no hay más miembros que el creador, "No one else is part of this event yet." + el mismo enlace. Error de la API en `role="alert"`.

Implementar con `Modal`/`ModalContent`/`ModalTitle`/`ModalDescription`, `useMembers(eventId)` (sólo se monta con `open`, para no pedir la lista hasta abrir: renderizar el contenido dentro de un componente hijo que sólo existe con `open === true`), `MembersList variant="budget"` con `members.filter(m => !m.owner)` y `Link` de react-router para "Manage members".

- [ ] **Step 2: Budget (test que falla)** — en `budget-screen.test.tsx`: con `budgetAccess: 'edit'` aparece el botón "Share" y al pulsarlo se abre "Share budget"; con `'view'` NO aparece (ni "Add Expense", que ya está probado). Mockear `../members/members-api`.

En `budget-screen.tsx`, dentro de `{canEdit ? (...) : null}` de la cabecera, agrupar en un `<div className="flex gap-3">` un `Button variant="outline"` "Share" (icono si `budget-icons.tsx` tiene uno adecuado; si no, sin icono) que hace `setSharing(true)`, y el "Add Expense" existente; montar `<ShareBudgetModal eventId={eventId} open={sharing} onOpenChange={setSharing} />` al final. Actualizar el docblock de modos ("`edit` añade, edita, borra y comparte").

- [ ] **Step 3: Modo «Ver» fijado con tests** — sin cambios de código (spec §4.4):
  - `dashboard-screen.test.tsx`: con `budgetAccess: 'view'` e `isOwner: false`, la tarjeta "Budget Overview" aparece con sus cifras y no hay acciones de edición (comprobar el texto o enlace que `BudgetCard` sólo muestra al owner; leer `dashboard-cards.tsx`).
  - `event-vendors-screen.test.tsx`: con `budgetAccess: 'view'` e `isOwner: false`, se ve el importe asignado y no los botones de editar/quitar.
  - `app-layout.test.tsx`: con `budgetAccess: 'view'` el menú incluye "Budget" y no "Settings".

- [ ] **Step 4: Verlo pasar y gates completos**

```bash
npx vitest run src/features/members src/features/budget src/features/dashboard src/features/event-vendors src/app
npm test && npm run typecheck && npm run lint && npx prettier --check .
```

- [ ] **Step 5: Commit**

```bash
git add src/features src/app
git commit -m "feat: compartir el presupuesto desde Budget y modo de sólo lectura fijado

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: PR del frontend

- [ ] **Step 1:** Arrancar backend (`npm run dev` en el backend, con `.env`) y frontend (`npm run dev`) y recorrer a mano: invitar desde Settings, aceptar con la otra cuenta desde el selector, conceder ver desde Share, comprobar Budget en lectura con la cuenta invitada, retirar el permiso y comprobar que Budget desaparece del menú al recargar.
- [ ] **Step 2:** `git push -u origin feat/miembros-presupuesto` y, con confirmación del usuario, `gh pr create --base develop` con resumen, enlace al PR del backend (depende de él) y la línea `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
