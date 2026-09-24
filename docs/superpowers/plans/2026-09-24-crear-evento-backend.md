# Crear evento — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar en la API lo que necesita el wizard de creación de eventos:
- borradores (`DRAFT` → `ACTIVE`) que siguen totalmente editables;
- lugar con coordenadas;
- cronograma con estado;
- catálogo de proveedores;
- gastos vinculados a un proveedor o externos, con su resumen de presupuesto.

**Architecture:** Clean Architecture por módulo, como el resto del repo: `domain/` puro, `application/` con casos de uso y puertos, `infrastructure/` con adaptadores Prisma y dobles en memoria, e `interfaces/` con controladores y DTO Zod.
- `events` y `vendors` se amplían.
- Se crean dos módulos nuevos: `schedule` y `expenses`.
- Los montos son strings decimales en el dominio y en la API. La aritmética del doble se hace en céntimos `bigint` y la de Postgres con `Decimal`.

**Tech Stack:** NestJS 11, Prisma 6 y PostgreSQL 16, Zod 4, Vitest 3, Testcontainers y supertest.

**Spec:** `docs/superpowers/specs/2026-09-24-crear-evento-design.md`. El frontend va en un plan aparte, en el repo del frontend, y consume esta API.

## Global Constraints

- Rama `feat/crear-evento` desde `main`, con PR contra `main`.
- Commits Conventional con descripción en español, terminados con la línea `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Idioma:
  - En español: comentarios, docblocks, mensajes de error, nombres de test y nombres de métodos de repositorio (`buscarPorId`, `actualizar`…).
  - En inglés: nombres de fichero y clase de casos de uso, controladores y módulos, y modelos y campos de Prisma.
- Capas (gate de CI con `npm run lint:arch`):
  - `domain/` solo importa `node:*` y `@/shared/domain`.
  - `application/` no importa `infrastructure/` ni `interfaces/`.
  - Un módulo no importa el `domain/` ni el `infrastructure/` de otro. Única excepción: los tests pueden usar los `*.fake.ts` de otro módulo.
- Validación en la frontera: `@Body() body: unknown` + `validarCon(schema, body)`. Los ids de ruta pasan por `idDeRuta(id, () => new XNoEncontradoError())`.
- Autorización:
  - `@UseGuards(JwtAuthGuard, EventAccessGuard)` en la clase.
  - `@RequireEventAccess('COUPLE', 'PLANNER')` en **cada** método.
  - Sin acceso → 404.
- Errores: subclases en español de `NotFoundError`, `ConflictError` y `UnprocessableError` (`@/shared/domain`).
- Montos:
  - En la API y en el dominio son `string` con dos decimales (`"45000.00"`).
  - En la entrada se aceptan como number o string, con hasta 10 dígitos enteros y 2 decimales.
  - Una columna `Decimal(12,2)`.
- Monedas soportadas: `USD, EUR, MXN, COP, ARS, CLP, PEN, BRL, GBP, CAD`.
- Campos obligatorios para publicar: `name, weddingDate, timezone, currency, totalBudget, venue` (dirección + coordenadas).
- Un evento `ACTIVE` es editable en todo, moneda incluida. Solo se rechaza (422 `EVENT_INCOMPLETE` con `details.faltantes`) el parche que vacía un campo obligatorio.
- Un VENDOR no ve eventos `DRAFT`, ni en `GET /events` ni en `GET /events/:id`.
- Comandos:
  - `npm run typecheck`
  - `npm run lint`
  - `npx prettier --check .`
  - `npx vitest run <ruta>`
  - `npm test` (necesita Docker)

## Review Focus

1. **Evento `DRAFT` sin fecha con invitaciones ya enviadas.** Si se borra `weddingDate` en un borrador, el RSVP público y el worker de invitaciones no deben dar 500. Esperado: `weddingDate: null` en la vista pública, `rsvpClosesAt: null` (el RSVP sigue abierto) y el correo dice "a date to be confirmed". El test va en la Tarea 2.
2. **Montos con formato raro.** `"1,500"`, `"12.345"`, `-1`, `1e21` o `"abc"` deben dar 400, nunca 500 ni una truncación silenciosa. `1500` y `"1500.5"` se normalizan a `"1500.00"` y `"1500.50"`. Tests en las Tareas 4 y 8.
3. **Un PATCH vacío o con `venue: null` sobre un evento `ACTIVE`.** El vacío da 400 (se exige al menos un cambio) y `venue: null` da 422 con `faltantes: ['venue']`. Test en la Tarea 7.
4. **Gasto con un `eventVendorId` de OTRO evento, o que no es UUID.** Da 404 `EVENT_VENDOR_NOT_FOUND` y nunca crea el gasto. Tests en las Tareas 12 y 13.
5. **Un VENDOR BOOKED en un evento que sigue en `DRAFT`.** No aparece en su `GET /events` y el detalle le da 404. Deja de ser así en cuanto el evento se publica. Test en la Tarea 6 (paridad) y en la Tarea 8 (e2e).

---

## File Structure

**Crear:**
- `prisma/migrations/20260924120000_add_event_draft_schedule_expenses/migration.sql`: esquema y CHECKs.
- `src/shared/domain/monto.ts` (+ `.test.ts`): normalización y aritmética de montos en céntimos.
- `src/shared/domain/ubicacion.ts` (+ `.test.ts`): value object `Ubicacion`.
- `src/modules/events/domain/moneda.ts`: lista `MONEDAS`.
- `src/modules/events/domain/publicacion.ts` (+ `.test.ts`): `camposFaltantesParaPublicar` y `completitud`.
- `src/modules/events/application/update-event.use-case.ts` (+ test).
- `src/modules/events/application/publish-event.use-case.ts` (+ test).
- `src/modules/events/application/create-event.use-case.test.ts`.
- `src/modules/events/infrastructure/event.repository.paridad.test.ts`.
- `src/modules/vendors/application/vendor-catalog.repository.ts`: puerto del catálogo.
- `src/modules/vendors/application/search-vendor-catalog.use-case.ts` (+ test).
- `src/modules/vendors/infrastructure/prisma-vendor-catalog.repository.ts` y `vendor-catalog.repository.fake.ts`.
- `src/modules/vendors/interfaces/vendor-catalog.controller.ts` y `vendor-catalog.dto.ts`.
- `src/modules/schedule/**`: módulo completo.
- `src/modules/expenses/**`: módulo completo.
- `test/support/eventos.ts`: helper e2e `crearEventoPublicado`.
- `test/e2e/events-draft.e2e.test.ts`, `schedule.e2e.test.ts`, `vendor-catalog.e2e.test.ts`, `expenses.e2e.test.ts`.

**Modificar:**
- `prisma/schema.prisma` y `docs/DATABASE.md`.
- `src/shared/domain/domain-error.ts`, `src/shared/domain/index.ts` y `src/shared/http/domain-exception.filter.ts`.
- `src/shared/http/limitadores.ts`: limitador `vendor-catalog`.
- `src/modules/events/`:
  - `domain/event.ts`, `domain/event-errors.ts`
  - `application/event.repository.ts`, `application/create-event.use-case.ts`
  - `infrastructure/prisma-event.repository.ts`, `infrastructure/event.repository.fake.ts`
  - `interfaces/events.dto.ts`, `interfaces/events.controller.ts`
  - `events.module.ts`
- `src/modules/guests/`:
  - `domain/invitation.ts` (+ test)
  - `application/invitation.repository.ts`, `application/get-rsvp.use-case.ts` (+ test)
  - `infrastructure/prisma-invitation.repository.ts`, `infrastructure/invitation.repository.fake.ts`
  - `interfaces/invitation.processor.ts`
- `src/modules/mail/application/invitation-renderer.port.ts` (sin cambio de tipo: sigue siendo `string`).
- `src/modules/vendors/`: `application/event-vendor.repository.ts`, `application/add-event-vendor.use-case.ts`, `application/remove-event-vendor.use-case.ts` (+ tests), `domain/vendor-errors.ts`, `infrastructure/*`, `interfaces/*` y `vendors.module.ts`.
- `src/app.module.ts`: registrar `ScheduleModule` y `ExpensesModule`.
- `test/support/schema.test.ts`.
- `test/e2e/event-vendors.e2e.test.ts`, `event-access.e2e.test.ts` y `guests.e2e.test.ts`: crear eventos publicados.

---

### Task 1: Esquema, migración y adaptación de tipos

Cambia el modelo y deja todo el repo compilando con el tipo de fila nuevo. Todavía no cambia ningún comportamiento de la API.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260924120000_add_event_draft_schedule_expenses/migration.sql`
- Modify: `test/support/schema.test.ts`
- Modify: `src/modules/events/infrastructure/prisma-event.repository.ts` (`aDominio`, `crearConMembresia`)
- Modify: `src/modules/guests/infrastructure/prisma-invitation.repository.ts` (`aInvitacion`)
- Modify: `docs/DATABASE.md`

**Interfaces:**
- Produces: modelos Prisma `ScheduleItem` y `Expense`, enums `EventStatus`, `ScheduleItemStatus` y `ExpenseStatus`, y en `Event` las columnas `status`, `currency`, `totalBudget`, `venueName`, `venueAddress`, `venueLat`, `venueLng`, `venueMapboxId`, con `weddingDate` nullable. `venueLocation` desaparece.

- [ ] **Step 1: Escribir los tests de restricciones que fallan**

Añadir al final del `describe('restricciones del esquema')` de `test/support/schema.test.ts`:

```ts
  describe('eventos, cronograma y gastos', () => {
    let ownerId: string

    beforeAll(async () => {
      const owner = await prisma.user.findFirstOrThrow({ where: { email: 'owner@test.com' } })
      ownerId = owner.id
    })

    it('un evento nuevo nace en DRAFT y admite no tener fecha', async () => {
      const evento = await prisma.event.create({ data: { name: 'Borrador', ownerId } })
      expect(evento.status).toBe('DRAFT')
      expect(evento.weddingDate).toBeNull()
      expect(evento.currency).toBe('USD')
    })

    it('rechaza un evento ACTIVE sin fecha', async () => {
      await expect(
        prisma.event.create({ data: { name: 'X', ownerId, status: 'ACTIVE' } }),
      ).rejects.toThrow(/events_activo_con_fecha/)
    })

    it('rechaza latitud sin longitud en el venue', async () => {
      await expect(
        prisma.event.create({ data: { name: 'X', ownerId, venueLat: 4.6 } }),
      ).rejects.toThrow(/events_venue_coords/)
    })

    it('rechaza una latitud fuera de rango', async () => {
      await expect(
        prisma.event.create({ data: { name: 'X', ownerId, venueLat: 91, venueLng: 0 } }),
      ).rejects.toThrow(/events_venue_coords/)
    })

    it('rechaza un presupuesto total negativo', async () => {
      await expect(
        prisma.event.create({ data: { name: 'X', ownerId, totalBudget: -1 } }),
      ).rejects.toThrow(/events_total_budget_no_negativo/)
    })

    it('rechaza un ítem de cronograma que acaba antes de empezar', async () => {
      await expect(
        prisma.scheduleItem.create({
          data: {
            eventId,
            title: 'Fiesta',
            startsAt: new Date('2027-06-12T20:00:00Z'),
            endsAt: new Date('2027-06-12T19:00:00Z'),
          },
        }),
      ).rejects.toThrow(/schedule_items_rango/)
    })

    it('rechaza un gasto con proveedor Y beneficiario externo', async () => {
      const vendor = await prisma.eventVendor.create({
        data: { eventId, externalName: 'DJ', category: 'Music' },
      })
      await expect(
        prisma.expense.create({
          data: {
            eventId,
            eventVendorId: vendor.id,
            payeeName: 'Otro',
            concept: 'Anticipo',
            category: 'Music',
            amount: 100,
            createdById: ownerId,
          },
        }),
      ).rejects.toThrow(/expenses_origen_exclusivo/)
    })

    it('rechaza un gasto sin ningún origen', async () => {
      await expect(
        prisma.expense.create({
          data: { eventId, concept: 'X', category: 'X', amount: 100, createdById: ownerId },
        }),
      ).rejects.toThrow(/expenses_origen_exclusivo/)
    })

    it('rechaza un gasto de monto cero', async () => {
      await expect(
        prisma.expense.create({
          data: {
            eventId,
            payeeName: 'Imprenta',
            concept: 'X',
            category: 'X',
            amount: 0,
            createdById: ownerId,
          },
        }),
      ).rejects.toThrow(/expenses_monto_positivo/)
    })

    it('rechaza un gasto PAID sin fecha de pago', async () => {
      await expect(
        prisma.expense.create({
          data: {
            eventId,
            payeeName: 'Imprenta',
            concept: 'X',
            category: 'X',
            amount: 10,
            status: 'PAID',
            createdById: ownerId,
          },
        }),
      ).rejects.toThrow(/expenses_pagado_con_fecha/)
    })

    it('impide borrar un EventVendor que tiene gastos', async () => {
      const vendor = await prisma.eventVendor.create({
        data: { eventId, externalName: 'Flores', category: 'Floral' },
      })
      await prisma.expense.create({
        data: {
          eventId,
          eventVendorId: vendor.id,
          concept: 'Anticipo',
          category: 'Floral',
          amount: 50,
          createdById: ownerId,
        },
      })
      await expect(prisma.eventVendor.delete({ where: { id: vendor.id } })).rejects.toThrow()
    })
  })
```

En el `beforeAll` de arriba, el evento compartido se crea sin `status`, así que ahora nacerá en DRAFT. Los tests de invitados de ese fichero no miran el estado, así que no hay que tocarlo.

- [ ] **Step 2: Ejecutar para ver que falla**

Run: `npx vitest run test/support/schema.test.ts`
Expected: falla la compilación de tipos o el runtime con `Unknown argument status` / `prisma.scheduleItem is undefined`.

- [ ] **Step 3: Editar `prisma/schema.prisma`**

Enums nuevos, junto a los existentes:

```prisma
enum EventStatus {
  DRAFT
  ACTIVE
}

enum ScheduleItemStatus {
  PENDING
  IN_PROGRESS
  DONE
}

enum ExpenseStatus {
  PENDING
  PAID
}
```

`model Event` queda así. Se elimina `venueLocation` y se mantiene el resto de campos y relaciones:

```prisma
model Event {
  id               String      @id @default(uuid()) @db.Uuid
  name             String
  status           EventStatus @default(DRAFT)
  weddingDate      DateTime?
  timezone         String      @default("UTC")
  currency         String      @default("USD") @db.Char(3)
  totalBudget      Decimal?    @db.Decimal(12, 2)
  venueName        String?
  venueAddress     String?
  venueLat         Decimal?    @db.Decimal(9, 6)
  venueLng         Decimal?    @db.Decimal(9, 6)
  venueMapboxId    String?
  rsvpDeadlineDays Int         @default(14)
  ownerId          String      @db.Uuid
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt

  owner         User              @relation("EventOwner", fields: [ownerId], references: [id])
  memberships   EventMembership[]
  vendors       EventVendor[]
  guests        Guest[]
  notifications Notification[]
  scheduleItems ScheduleItem[]
  expenses      Expense[]

  @@index([ownerId])
  @@map("events")
}

model ScheduleItem {
  id               String             @id @default(uuid()) @db.Uuid
  eventId          String             @db.Uuid
  title            String
  description      String?
  startsAt         DateTime
  endsAt           DateTime?
  locationName     String?
  locationAddress  String?
  locationLat      Decimal?           @db.Decimal(9, 6)
  locationLng      Decimal?           @db.Decimal(9, 6)
  locationMapboxId String?
  status           ScheduleItemStatus @default(PENDING)
  createdAt        DateTime           @default(now())
  updatedAt        DateTime           @updatedAt

  event Event @relation(fields: [eventId], references: [id], onDelete: Cascade)

  @@index([eventId, startsAt])
  @@map("schedule_items")
}

model Expense {
  id            String        @id @default(uuid()) @db.Uuid
  eventId       String        @db.Uuid
  eventVendorId String?       @db.Uuid
  payeeName     String?
  concept       String
  category      String
  amount        Decimal       @db.Decimal(12, 2)
  status        ExpenseStatus @default(PENDING)
  dueDate       DateTime?     @db.Date
  paidAt        DateTime?
  notes         String?
  createdById   String        @db.Uuid
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt

  event       Event        @relation(fields: [eventId], references: [id], onDelete: Cascade)
  eventVendor EventVendor? @relation(fields: [eventVendorId], references: [id], onDelete: Restrict)
  createdBy   User         @relation("ExpenseCreatedBy", fields: [createdById], references: [id])

  @@index([eventId, createdAt, id])
  @@index([eventVendorId])
  @@map("expenses")
}
```

Añadir `expenses Expense[]` a `model EventVendor` y `expensesCreated Expense[] @relation("ExpenseCreatedBy")` a `model User`.

- [ ] **Step 4: Generar la migración y añadir a mano los pasos de datos y los CHECK**

Run: `npx prisma migrate dev --create-only --name add_event_draft_schedule_expenses`

Renombrar la carpeta a `20260924120000_add_event_draft_schedule_expenses` si el timestamp generado es otro. Después editar el SQL:

1. Donde Prisma escribe `ALTER TABLE "events" ADD COLUMN "status" "EventStatus" NOT NULL DEFAULT 'DRAFT'`, poner `DEFAULT 'ACTIVE'`. Justo después:

```sql
-- Las filas existentes se crearon con fecha obligatoria: son eventos publicados.
-- Una vez rellenas, el default pasa a DRAFT para los eventos nuevos.
ALTER TABLE "events" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
```

2. Antes del `DROP COLUMN "venueLocation"` que genera Prisma, añadir:

```sql
-- venueLocation era texto libre: se conserva como dirección, sin coordenadas.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "venueAddress" TEXT;
UPDATE "events" SET "venueAddress" = "venueLocation" WHERE "venueLocation" IS NOT NULL;
```

Si Prisma ya creó `venueAddress` en otra sentencia, se quita esa sentencia duplicada: la columna solo se crea una vez. El `UPDATE` tiene que ir antes del `DROP`.

3. Al final:

```sql
ALTER TABLE "events" ADD CONSTRAINT "events_venue_coords" CHECK (
  ("venueLat" IS NULL) = ("venueLng" IS NULL)
  AND ("venueLat" IS NULL OR "venueLat" BETWEEN -90 AND 90)
  AND ("venueLng" IS NULL OR "venueLng" BETWEEN -180 AND 180)
);
ALTER TABLE "events" ADD CONSTRAINT "events_total_budget_no_negativo"
  CHECK ("totalBudget" IS NULL OR "totalBudget" >= 0);
ALTER TABLE "events" ADD CONSTRAINT "events_activo_con_fecha"
  CHECK ("status" = 'DRAFT' OR "weddingDate" IS NOT NULL);

ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_rango"
  CHECK ("endsAt" IS NULL OR "endsAt" >= "startsAt");
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_coords" CHECK (
  ("locationLat" IS NULL) = ("locationLng" IS NULL)
  AND ("locationLat" IS NULL OR "locationLat" BETWEEN -90 AND 90)
  AND ("locationLng" IS NULL OR "locationLng" BETWEEN -180 AND 180)
);

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_monto_positivo" CHECK ("amount" > 0);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_origen_exclusivo"
  CHECK (("eventVendorId" IS NULL) <> ("payeeName" IS NULL));
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_pagado_con_fecha"
  CHECK (("status" = 'PAID') = ("paidAt" IS NOT NULL));
```

Run: `npx prisma migrate dev` (aplica la migración en la base local) y `npx prisma generate`.

- [ ] **Step 5: Hacer que compile: adaptadores Prisma de eventos e invitaciones**

Tipos puente en `src/modules/events/domain/event.ts`. La forma definitiva llega en la Tarea 6. Por ahora solo se ajusta lo que la fila ya no tiene:

```ts
export interface Event {
  id: string
  name: string
  weddingDate: Date | null
  timezone: string
  venueLocation: string | null
  rsvpDeadlineDays: number
  ownerId: string
  createdAt: Date
  updatedAt: Date
}
```

En `prisma-event.repository.ts`, `aDominio` usa `venueLocation: fila.venueAddress` y `weddingDate: fila.weddingDate`.

En `events.controller.ts`, `aRespuesta` pasa a tipar `weddingDate: Date | null` y a devolver `weddingDate: evento.weddingDate?.toISOString() ?? null`. `EventoRespuesta.weddingDate` pasa a `string | null`.

En `prisma-invitation.repository.ts`, `aInvitacion` sigue devolviendo `Date` hasta la Tarea 2. Para que compile, solo en este paso:

```ts
      // Tarea 2 lo vuelve nullable de verdad; hasta entonces un evento sin
      // fecha no puede tener invitaciones porque solo existían eventos ACTIVE.
      weddingDate: fila.guest.event.weddingDate ?? new Date(0),
```

- [ ] **Step 6: Ejecutar los tests**

Run: `npm run typecheck && npx vitest run test/support/schema.test.ts`
Expected: PASS.

Run: `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code` (el mismo comando que `.github/workflows/ci.yml`; se copia de ahí).
Expected: exit 0.

- [ ] **Step 7: Documentar en `docs/DATABASE.md`**

Añadir las secciones de `schedule_items` y `expenses` y las columnas nuevas de `events`, con una línea por CHECK: los nombres de arriba y qué impiden. Actualizar la fila de `events` quitando `venueLocation`. Está en inglés, igual que el resto del documento.

- [ ] **Step 8: Commit**

```bash
git add prisma docs/DATABASE.md test/support/schema.test.ts src
git commit -m "feat: esquema de borradores, cronograma y gastos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Invitados con un evento sin fecha

Un `DRAFT` puede quedarse sin fecha cuando ya hay invitaciones enviadas. El RSVP y el worker tienen que tolerarlo.

**Files:**
- Modify: `src/modules/guests/domain/invitation.ts` y `invitation.test.ts`
- Modify: `src/modules/guests/application/invitation.repository.ts` (tipo `InvitacionCompleta`)
- Modify: `src/modules/guests/application/get-rsvp.use-case.ts` y su test
- Modify: `src/modules/guests/infrastructure/prisma-invitation.repository.ts` y `invitation.repository.fake.ts`
- Modify: `src/modules/guests/interfaces/invitation.processor.ts`

**Interfaces:**
- Produces:
  - `cierreRsvp(evento: { weddingDate: Date | null; rsvpDeadlineDays: number }): Date | null`
  - `InvitacionCompleta.event.weddingDate: Date | null`
  - `VistaPublicaRsvp.weddingDate: string | null` y `rsvpClosesAt: string | null`

- [ ] **Step 1: Tests de dominio que fallan**

En `src/modules/guests/domain/invitation.test.ts`:

```ts
  it('sin fecha de boda no hay cierre de RSVP', () => {
    expect(cierreRsvp({ weddingDate: null, rsvpDeadlineDays: 14 })).toBeNull()
  })

  it('sin fecha de boda se puede responder mientras el token viva', () => {
    const inv = { expiresAt: new Date('2027-01-01T00:00:00Z') }
    const evento = { weddingDate: null, rsvpDeadlineDays: 14 }
    expect(admiteRespuesta(inv, evento, new Date('2026-12-31T00:00:00Z'))).toBe(true)
    expect(admiteRespuesta(inv, evento, new Date('2027-01-02T00:00:00Z'))).toBe(false)
  })
```

En `get-rsvp.use-case.test.ts`, siguiendo el patrón de siembra del fichero (`invitaciones.sembrar(...)` o equivalente, con `event: { weddingDate: null }`):

```ts
  it('con el evento sin fecha devuelve fecha y cierre nulos', async () => {
    // Sembrar igual que el test "devuelve la vista pública", pero con
    // event: { weddingDate: null }.
    const vista = await caso.ejecutar(token)
    expect(vista.weddingDate).toBeNull()
    expect(vista.rsvpClosesAt).toBeNull()
  })
```

Para sembrar se copia literalmente el `arrange` del primer test del fichero y solo se cambia `weddingDate`.

- [ ] **Step 2: Ejecutar para ver que falla**

Run: `npx vitest run src/modules/guests`
Expected: FAIL (errores de tipo y `expected Date to be null`).

- [ ] **Step 3: Implementar**

`src/modules/guests/domain/invitation.ts`:

```ts
/**
 * Momento a partir del cual el invitado ya no puede cambiar su respuesta.
 * `null` cuando el evento es un borrador sin fecha: no hay nada contra lo que
 * contar los días, así que el RSVP queda abierto mientras el token viva.
 */
export function cierreRsvp(evento: {
  weddingDate: Date | null
  rsvpDeadlineDays: number
}): Date | null {
  if (evento.weddingDate === null) return null
  return new Date(evento.weddingDate.getTime() - evento.rsvpDeadlineDays * 86_400_000)
}

export function admiteRespuesta(
  invitacion: { expiresAt: Date },
  evento: { weddingDate: Date | null; rsvpDeadlineDays: number },
  ahora: Date,
): boolean {
  const cierre = cierreRsvp(evento)
  return admiteLectura(invitacion, ahora) && (cierre === null || ahora.getTime() < cierre.getTime())
}
```

En `invitation.repository.ts`: `event: { id: string; name: string; weddingDate: Date | null; rsvpDeadlineDays: number }`.

En `prisma-invitation.repository.ts`, dentro de `aInvitacion`: `weddingDate: fila.guest.event.weddingDate` (se quita el `?? new Date(0)`).

En `invitation.repository.fake.ts`, el tipo de los datos sembrados admite `weddingDate?: Date | null`. El default se mantiene, pero con `!== undefined` para que un `null` explícito se respete:

```ts
        weddingDate:
          datos.event?.weddingDate !== undefined
            ? datos.event.weddingDate
            : (previo?.event.weddingDate ?? new Date(Date.now() + 180 * 86_400_000)),
```

En `get-rsvp.use-case.ts`: `weddingDate: string | null` y `rsvpClosesAt: string | null` en `VistaPublicaRsvp`; y en `ejecutar`:

```ts
      weddingDate: invitacion.event.weddingDate?.toISOString() ?? null,
      rsvp: invitado.rsvp,
      dietary: invitado.dietary,
      rsvpClosesAt: cierreRsvp(invitacion.event)?.toISOString() ?? null,
```

En `invitation.processor.ts`:

```ts
function formatearFecha(fecha: Date | null): string {
  // Borrador sin fecha: el correo se envía igual; la plantilla dice "on {weddingDate}".
  if (fecha === null) return 'a date to be confirmed'
  return fecha.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })
}
```

- [ ] **Step 4: Ejecutar los tests**

Run: `npm run typecheck && npx vitest run src/modules/guests test/e2e/rsvp.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/guests
git commit -m "feat: el RSVP tolera eventos en borrador sin fecha

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `details` en los errores de dominio

**Files:**
- Modify: `src/shared/domain/domain-error.ts`
- Modify: `src/shared/http/domain-exception.filter.ts`
- Test: `src/shared/http/domain-exception.filter.test.ts` (crear si no existe; si existe, añadir el caso)

**Interfaces:**
- Produces: `DomainError.details?: unknown`, y `new UnprocessableError(message, code, details)`. El filtro serializa `details` cuando existe.

- [ ] **Step 1: Test que falla**

```ts
import type { ArgumentsHost } from '@nestjs/common'

import { UnprocessableError } from '../domain'
import { DomainExceptionFilter } from './domain-exception.filter'

function hostFalso(): { host: ArgumentsHost; enviado: { status?: number; body?: unknown } } {
  const enviado: { status?: number; body?: unknown } = {}
  const res = {
    status: (code: number) => {
      enviado.status = code
      return { json: (body: unknown) => (enviado.body = body) }
    },
  }
  const host = {
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => res }),
  } as unknown as ArgumentsHost
  return { host, enviado }
}

describe('DomainExceptionFilter con details', () => {
  it('serializa los details de un DomainError', () => {
    const { host, enviado } = hostFalso()
    new DomainExceptionFilter().catch(
      new UnprocessableError('Faltan datos', 'EVENT_INCOMPLETE', { faltantes: ['venue'] }),
      host,
    )
    expect(enviado.status).toBe(422)
    expect(enviado.body).toEqual({
      code: 'EVENT_INCOMPLETE',
      message: 'Faltan datos',
      details: { faltantes: ['venue'] },
    })
  })

  it('sin details no añade la clave', () => {
    const { host, enviado } = hostFalso()
    new DomainExceptionFilter().catch(new UnprocessableError('X'), host)
    expect(enviado.body).toEqual({ code: 'UNPROCESSABLE', message: 'X' })
  })
})
```

- [ ] **Step 2: Ejecutar**

Run: `npx vitest run src/shared/http/domain-exception.filter.test.ts`
Expected: FAIL (el constructor tiene 2 argumentos y `details` no aparece).

- [ ] **Step 3: Implementar**

`domain-error.ts`:

```ts
export abstract class DomainError extends Error {
  abstract readonly httpStatus: number

  /**
   * `details` es para el cliente, no para el log: datos estructurados que la UI
   * necesita para reaccionar (p. ej. qué campos faltan para publicar). Nunca
   * lleva datos personales ni internos.
   */
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = new.target.name
  }
}
```

Y en `UnprocessableError`:

```ts
export class UnprocessableError extends DomainError {
  readonly httpStatus = 422
  constructor(message: string, code = 'UNPROCESSABLE', details?: unknown) {
    super(message, code, details)
  }
}
```

En `domain-exception.filter.ts`, dentro de `traducir`:

```ts
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        cuerpo: {
          code: exception.code,
          message: exception.message,
          ...(exception.details !== undefined ? { details: exception.details } : {}),
        },
      }
    }
```

- [ ] **Step 4: Ejecutar**

Run: `npx vitest run src/shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared
git commit -m "feat: los errores de dominio pueden llevar details para el cliente

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Value objects `monto` y `Ubicacion`

**Files:**
- Create: `src/shared/domain/monto.ts` y `src/shared/domain/monto.test.ts`
- Create: `src/shared/domain/ubicacion.ts` y `src/shared/domain/ubicacion.test.ts`
- Modify: `src/shared/domain/index.ts`

**Interfaces:**
- Produces:
  - `normalizarMonto(valor: number | string): string`: lanza `MontoInvalidoError` (422 `INVALID_AMOUNT`).
  - `aCentimos(monto: string): bigint` y `deCentimos(centimos: bigint): string`, que admite negativos.
  - `interface Ubicacion { name: string | null; address: string; lat: number; lng: number; mapboxId: string | null }`.
  - `crearUbicacion(entrada: EntradaUbicacion): Ubicacion`: lanza `UbicacionInvalidaError` (422 `INVALID_LOCATION`).
  - `interface EntradaUbicacion { name?: string | null | undefined; address: string; lat: number; lng: number; mapboxId?: string | null | undefined }`.

- [ ] **Step 1: Tests que fallan**

`src/shared/domain/monto.test.ts`:

```ts
import { aCentimos, deCentimos, MontoInvalidoError, normalizarMonto } from './monto'

describe('normalizarMonto', () => {
  it.each([
    [1500, '1500.00'],
    ['1500', '1500.00'],
    ['1500.5', '1500.50'],
    [0.1, '0.10'],
    ['0', '0.00'],
    [' 12.34 ', '12.34'],
    [9_999_999_999.99, '9999999999.99'],
  ])('%p → %p', (entrada, esperado) => {
    expect(normalizarMonto(entrada)).toBe(esperado)
  })

  it.each([['1,500'], ['12.345'], [-1], ['-1'], [1e21], ['abc'], [''], [Number.NaN], ['1e3'], [10_000_000_000]])(
    'rechaza %p',
    (entrada) => {
      expect(() => normalizarMonto(entrada)).toThrow(MontoInvalidoError)
    },
  )
})

describe('céntimos', () => {
  it('ida y vuelta exacta', () => {
    expect(aCentimos('45000.00')).toBe(4_500_000n)
    expect(deCentimos(4_500_000n)).toBe('45000.00')
  })

  it('deCentimos admite negativos (lo que queda puede ser negativo)', () => {
    expect(deCentimos(-150n)).toBe('-1.50')
    expect(deCentimos(-5n)).toBe('-0.05')
  })

  it('suma sin error de coma flotante', () => {
    expect(deCentimos(aCentimos('0.10') + aCentimos('0.20'))).toBe('0.30')
  })
})
```

`src/shared/domain/ubicacion.test.ts`:

```ts
import { crearUbicacion, UbicacionInvalidaError } from './ubicacion'

describe('crearUbicacion', () => {
  it('normaliza vacíos a null y recorta la dirección', () => {
    expect(
      crearUbicacion({ name: '  ', address: '  Calle 1 #2-3, Bogotá ', lat: 4.6, lng: -74.08 }),
    ).toEqual({ name: null, address: 'Calle 1 #2-3, Bogotá', lat: 4.6, lng: -74.08, mapboxId: null })
  })

  it.each([
    [{ address: '', lat: 0, lng: 0 }],
    [{ address: 'X', lat: 91, lng: 0 }],
    [{ address: 'X', lat: 0, lng: -181 }],
    [{ address: 'X', lat: Number.NaN, lng: 0 }],
    [{ address: 'X', lat: 0, lng: Number.POSITIVE_INFINITY }],
  ])('rechaza %o', (entrada) => {
    expect(() => crearUbicacion(entrada)).toThrow(UbicacionInvalidaError)
  })
})
```

- [ ] **Step 2: Ejecutar**

Run: `npx vitest run src/shared/domain`
Expected: FAIL (no existen los módulos).

- [ ] **Step 3: Implementar**

`src/shared/domain/monto.ts`:

```ts
import { UnprocessableError } from './domain-error'

export class MontoInvalidoError extends UnprocessableError {
  constructor() {
    super('El monto no es válido: hasta 10 dígitos enteros y 2 decimales', 'INVALID_AMOUNT')
  }
}

/** Hasta 10 dígitos enteros y 2 decimales: lo que cabe en `Decimal(12,2)`. */
const MONTO = /^\d{1,10}(\.\d{1,2})?$/

/**
 * Los montos viajan como string con dos decimales ("45000.00") en el dominio y
 * en la API: un `number` de JS no representa 0.1 exacto, y sumar gastos en
 * coma flotante acaba mostrando 0.30000000000000004 en una factura.
 *
 * Un `number` se convierte con `toFixed(2)` SOLO si ya tiene como mucho dos
 * decimales, para no redondear en silencio lo que el cliente mandó.
 */
export function normalizarMonto(valor: number | string): string {
  let texto: string
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor) || valor < 0) throw new MontoInvalidoError()
    if (Math.round(valor * 100) / 100 !== valor) throw new MontoInvalidoError()
    texto = valor.toFixed(2)
  } else {
    texto = valor.trim()
  }
  if (!MONTO.test(texto)) throw new MontoInvalidoError()
  const [entero = '0', decimales = ''] = texto.split('.')
  return `${String(BigInt(entero))}.${decimales.padEnd(2, '0')}`
}

/** "12.34" → 1234n. Solo acepta montos ya normalizados (o negativos de `deCentimos`). */
export function aCentimos(monto: string): bigint {
  const negativo = monto.startsWith('-')
  const [entero = '0', decimales = '00'] = (negativo ? monto.slice(1) : monto).split('.')
  const valor = BigInt(entero) * 100n + BigInt(decimales.padEnd(2, '0').slice(0, 2))
  return negativo ? -valor : valor
}

export function deCentimos(centimos: bigint): string {
  const negativo = centimos < 0n
  const absoluto = negativo ? -centimos : centimos
  const texto = `${String(absoluto / 100n)}.${String(absoluto % 100n).padStart(2, '0')}`
  return negativo ? `-${texto}` : texto
}
```

`src/shared/domain/ubicacion.ts`:

```ts
import { UnprocessableError } from './domain-error'

export class UbicacionInvalidaError extends UnprocessableError {
  constructor() {
    super('La ubicación necesita dirección y coordenadas válidas', 'INVALID_LOCATION')
  }
}

/**
 * Un punto elegido en el mapa. Vive en `shared/domain` porque lo usan el
 * evento (venue) y cada ítem del cronograma, y un módulo no puede importar el
 * dominio de otro.
 *
 * Coordenadas en `number`: 6 decimales (~11 cm) caben de sobra en un double.
 * La columna es `Decimal(9,6)` para que no aparezca ruido al leerla.
 */
export interface Ubicacion {
  name: string | null
  address: string
  lat: number
  lng: number
  mapboxId: string | null
}

export interface EntradaUbicacion {
  name?: string | null | undefined
  address: string
  lat: number
  lng: number
  mapboxId?: string | null | undefined
}

function textoOpcional(valor: string | null | undefined): string | null {
  const recortado = valor?.trim() ?? ''
  return recortado === '' ? null : recortado
}

export function crearUbicacion(entrada: EntradaUbicacion): Ubicacion {
  const address = entrada.address.trim()
  const { lat, lng } = entrada
  if (address === '') throw new UbicacionInvalidaError()
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new UbicacionInvalidaError()
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new UbicacionInvalidaError()
  return {
    name: textoOpcional(entrada.name),
    address,
    lat,
    lng,
    mapboxId: textoOpcional(entrada.mapboxId),
  }
}
```

`src/shared/domain/index.ts`:

```ts
export * from './cursor'
export * from './domain-error'
export * from './monto'
export * from './ubicacion'
```

- [ ] **Step 4: Ejecutar**

Run: `npx vitest run src/shared/domain && npm run lint:arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/domain
git commit -m "feat: value objects de monto y ubicación

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Regla de publicación y completitud

**Files:**
- Create: `src/modules/events/domain/moneda.ts`
- Create: `src/modules/events/domain/publicacion.ts` y `publicacion.test.ts`
- Modify: `src/modules/events/domain/event.ts` (forma definitiva)
- Modify: `src/modules/events/domain/event-errors.ts`

**Interfaces:**
- Produces:

```ts
// event.ts
export type EventStatus = 'DRAFT' | 'ACTIVE'
export interface ConteosEvento { scheduleItems: number; vendors: number }
export interface Event {
  id: string
  name: string
  status: EventStatus
  weddingDate: Date | null
  timezone: string
  currency: string
  totalBudget: string | null
  venue: Ubicacion | null
  rsvpDeadlineDays: number
  ownerId: string
  conteos: ConteosEvento
  createdAt: Date
  updatedAt: Date
}
// moneda.ts
export const MONEDAS = ['USD','EUR','MXN','COP','ARS','CLP','PEN','BRL','GBP','CAD'] as const
export type Moneda = (typeof MONEDAS)[number]
// publicacion.ts
export type CampoPublicable = 'name' | 'weddingDate' | 'timezone' | 'currency' | 'totalBudget' | 'venue'
export type DatosPublicables = Pick<Event, 'name' | 'weddingDate' | 'timezone' | 'currency' | 'totalBudget' | 'venue'>
export function camposFaltantesParaPublicar(evento: DatosPublicables): CampoPublicable[]
export type EstadoPaso = 'completo' | 'parcial' | 'vacio'
export interface Completitud { general: EstadoPaso; venue: EstadoPaso; schedule: EstadoPaso; budget: EstadoPaso }
export function completitud(evento: Event): Completitud
// event-errors.ts
export class EventoIncompletoError extends UnprocessableError // code 'EVENT_INCOMPLETE', details { faltantes }
```

- [ ] **Step 1: Test que falla**

`src/modules/events/domain/publicacion.test.ts`:

```ts
import type { Event } from './event'
import { camposFaltantesParaPublicar, completitud } from './publicacion'

const VENUE = { name: 'Hacienda', address: 'Km 5 vía La Calera', lat: 4.7, lng: -73.9, mapboxId: null }

function evento(parcial: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    name: 'Boda Ana y Luis',
    status: 'DRAFT',
    weddingDate: new Date('2027-06-12T00:00:00Z'),
    timezone: 'America/Bogota',
    currency: 'COP',
    totalBudget: '45000000.00',
    venue: VENUE,
    rsvpDeadlineDays: 14,
    ownerId: 'u1',
    conteos: { scheduleItems: 0, vendors: 0 },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...parcial,
  }
}

describe('camposFaltantesParaPublicar', () => {
  it('un evento completo no tiene faltantes', () => {
    expect(camposFaltantesParaPublicar(evento())).toEqual([])
  })

  it('lista en orden fijo todo lo que falta', () => {
    expect(
      camposFaltantesParaPublicar(
        evento({ name: '  ', weddingDate: null, totalBudget: null, venue: null }),
      ),
    ).toEqual(['name', 'weddingDate', 'totalBudget', 'venue'])
  })

  it('presupuesto 0 cuenta como presente', () => {
    expect(camposFaltantesParaPublicar(evento({ totalBudget: '0.00' }))).toEqual([])
  })
})

describe('completitud', () => {
  it('borrador solo con nombre', () => {
    expect(completitud(evento({ weddingDate: null, totalBudget: null, venue: null }))).toEqual({
      general: 'parcial',
      venue: 'vacio',
      schedule: 'vacio',
      budget: 'vacio',
    })
  })

  it('todo completo', () => {
    expect(completitud(evento({ conteos: { scheduleItems: 3, vendors: 2 } }))).toEqual({
      general: 'completo',
      venue: 'completo',
      schedule: 'completo',
      budget: 'completo',
    })
  })

  it('presupuesto sin proveedores es parcial, y proveedores sin total también', () => {
    expect(completitud(evento()).budget).toBe('parcial')
    expect(completitud(evento({ totalBudget: null, conteos: { scheduleItems: 0, vendors: 1 } })).budget).toBe(
      'parcial',
    )
  })
})
```

- [ ] **Step 2: Ejecutar**

Run: `npx vitest run src/modules/events/domain/publicacion.test.ts`
Expected: FAIL (el módulo no existe).

- [ ] **Step 3: Implementar**

`src/modules/events/domain/event.ts` sustituye la interfaz `Event` por la de *Produces*, conserva `DIAS_DE_CIERRE_POR_DEFECTO` y añade `import type { Ubicacion } from '@/shared/domain'`.

`src/modules/events/domain/moneda.ts`:

```ts
/**
 * Monedas soportadas (ISO 4217). Lista acotada a propósito: cada una es una
 * decisión de producto (formato, mercados). El frontend usa la misma lista.
 */
export const MONEDAS = ['USD', 'EUR', 'MXN', 'COP', 'ARS', 'CLP', 'PEN', 'BRL', 'GBP', 'CAD'] as const
export type Moneda = (typeof MONEDAS)[number]
```

`src/modules/events/domain/publicacion.ts`:

```ts
import type { Event } from './event'

export type CampoPublicable =
  | 'name'
  | 'weddingDate'
  | 'timezone'
  | 'currency'
  | 'totalBudget'
  | 'venue'

export type DatosPublicables = Pick<
  Event,
  'name' | 'weddingDate' | 'timezone' | 'currency' | 'totalBudget' | 'venue'
>

/**
 * Lo mínimo para que un evento deje de ser borrador. Se aplica al publicar y
 * en cada PATCH sobre un evento ACTIVE: publicado, se puede editar TODO, pero
 * no dejarlo a medias. El orden es fijo para que la UI no baile.
 */
export function camposFaltantesParaPublicar(evento: DatosPublicables): CampoPublicable[] {
  const faltantes: CampoPublicable[] = []
  if (evento.name.trim() === '') faltantes.push('name')
  if (evento.weddingDate === null) faltantes.push('weddingDate')
  if (evento.timezone.trim() === '') faltantes.push('timezone')
  if (evento.currency.trim() === '') faltantes.push('currency')
  if (evento.totalBudget === null) faltantes.push('totalBudget')
  if (evento.venue === null) faltantes.push('venue')
  return faltantes
}

export type EstadoPaso = 'completo' | 'parcial' | 'vacio'

export interface Completitud {
  general: EstadoPaso
  venue: EstadoPaso
  schedule: EstadoPaso
  budget: EstadoPaso
}

/**
 * Solo alimenta el stepper del wizard; NO decide si se puede publicar (eso es
 * `camposFaltantesParaPublicar`). Cronograma y proveedores son opcionales
 * para publicar, pero el stepper enseña si ya se tocaron.
 */
export function completitud(evento: Event): Completitud {
  const tieneTotal = evento.totalBudget !== null
  const tieneVendors = evento.conteos.vendors > 0
  return {
    // `name` siempre existe (es obligatorio desde el primer guardado) y
    // timezone/currency tienen default: lo que distingue es la fecha.
    general: evento.weddingDate === null ? 'parcial' : 'completo',
    venue: evento.venue === null ? 'vacio' : 'completo',
    schedule: evento.conteos.scheduleItems > 0 ? 'completo' : 'vacio',
    budget: tieneTotal && tieneVendors ? 'completo' : tieneTotal || tieneVendors ? 'parcial' : 'vacio',
  }
}
```

En `event-errors.ts`, cambiar el import a `import { ConflictError, NotFoundError, UnprocessableError } from '@/shared/domain'` (ya está así) y añadir `import type { CampoPublicable } from './publicacion'`, además de:

```ts
/**
 * 422 con la lista de lo que falta: la UI la pinta en el paso Revisión (al
 * publicar) o en el campo que se intentó vaciar (al editar un ACTIVE).
 */
export class EventoIncompletoError extends UnprocessableError {
  constructor(faltantes: CampoPublicable[]) {
    super('Faltan datos obligatorios para publicar el evento', 'EVENT_INCOMPLETE', { faltantes })
  }
}
```

- [ ] **Step 4: Ejecutar**

Run: `npx vitest run src/modules/events/domain`
Expected: PASS. `npm run typecheck` va a FALLAR en el repositorio, el fake y el controlador de eventos, que todavía usan la forma vieja. Es lo esperado: lo arregla la Tarea 6, y el commit de esta tarea se hace junto con el de la Tarea 6.

- [ ] **Step 5: No se hace commit todavía.** Esta tarea y la Tarea 6 van en un solo commit, porque la forma nueva de `Event` rompe la compilación hasta que el repositorio la adopta.

---

### Task 6: Repositorio de eventos (borrador, actualizar, conteos, VENDOR sin borradores)

**Files:**
- Modify: `src/modules/events/application/event.repository.ts`
- Modify: `src/modules/events/infrastructure/prisma-event.repository.ts`
- Modify: `src/modules/events/infrastructure/event.repository.fake.ts`
- Create: `src/modules/events/infrastructure/event.repository.paridad.test.ts`
- Modify (compilación): `src/modules/events/interfaces/events.controller.ts` (`aRespuesta` provisional) y `src/modules/events/application/create-event.use-case.ts` (tipos)

**Interfaces:**
- Consumes: `Event`, `EventStatus` y `Ubicacion` (Tareas 4 y 5).
- Produces (puerto):

```ts
export interface DatosNuevoEvento {
  name: string
  ownerId: string
  rsvpDeadlineDays?: number | undefined
  weddingDate?: Date | null | undefined
  timezone?: string | undefined
  currency?: string | undefined
  totalBudget?: string | null | undefined
  venue?: Ubicacion | null | undefined
}

export interface CambiosEvento {
  name?: string | undefined
  status?: EventStatus | undefined
  weddingDate?: Date | null | undefined
  timezone?: string | undefined
  currency?: string | undefined
  totalBudget?: string | null | undefined
  venue?: Ubicacion | null | undefined
}

// en EventRepository:
crearConMembresia(datos: DatosNuevoEvento): Promise<Event> // nace DRAFT
actualizar(eventId: string, cambios: CambiosEvento): Promise<Event> // lanza EventoNoEncontradoError si no existe
```

- `buscarContratacionReservada` y `listarAccesiblesPor` solo cuentan contrataciones en eventos `ACTIVE`.
- Fake: `EventoEnMemoria` admite los campos nuevos opcionales (`status` por defecto `'ACTIVE'` al sembrar a mano, `conteos` por defecto `{0,0}`). `crearConMembresia` crea en `'DRAFT'`.

- [ ] **Step 1: Test de paridad que falla**

`src/modules/events/infrastructure/event.repository.paridad.test.ts`:

```ts
import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { EventRepository } from '../application/event.repository'
import { EventRepositoryEnMemoria } from './event.repository.fake'
import { PrismaEventRepository } from './prisma-event.repository'

const VENUE = { name: 'Hacienda', address: 'Km 5 vía La Calera', lat: 4.712345, lng: -73.912345, mapboxId: 'poi.1' }

/**
 * Cada caso corre contra el doble y contra Postgres y compara lo que devuelve
 * el puerto (ruling H1). Lo que no puede compararse (ids, timestamps) se
 * excluye con `sinVolatiles`.
 */
describe('Paridad: EventRepositoryEnMemoria vs PrismaEventRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let ownerId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const owner = await prisma.user.create({
      data: { email: 'owner@paridad.test', passwordHash: 'x', fullName: 'Owner' },
    })
    ownerId = owner.id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  function sujetos(): Array<[string, EventRepository]> {
    return [
      ['doble', new EventRepositoryEnMemoria()],
      ['prisma', new PrismaEventRepository(prisma as unknown as PrismaService)],
    ]
  }

  const sinVolatiles = ({ id: _id, createdAt: _c, updatedAt: _u, ownerId: _o, ...resto }: Record<string, unknown>) =>
    resto

  it('crea un borrador solo con nombre, con los defaults de la columna', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      resultados.push(sinVolatiles({ ...(await repo.crearConMembresia({ name: 'Boda', ownerId })) }))
    }
    expect(resultados[0]).toEqual({
      name: 'Boda',
      status: 'DRAFT',
      weddingDate: null,
      timezone: 'UTC',
      currency: 'USD',
      totalBudget: null,
      venue: null,
      rsvpDeadlineDays: 14,
      conteos: { scheduleItems: 0, vendors: 0 },
    })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('crea con todos los campos y los devuelve normalizados', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({
        name: 'Boda',
        ownerId,
        weddingDate: new Date('2027-06-12T00:00:00Z'),
        timezone: 'America/Bogota',
        currency: 'COP',
        totalBudget: '45000000.00',
        venue: VENUE,
      })
      resultados.push(sinVolatiles({ ...evento }))
    }
    expect(resultados[0]).toMatchObject({ totalBudget: '45000000.00', venue: VENUE, currency: 'COP' })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('actualizar aplica solo lo que llega y null borra', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      const creado = await repo.crearConMembresia({
        name: 'Boda',
        ownerId,
        totalBudget: '100.00',
        venue: VENUE,
      })
      const actualizado = await repo.actualizar(creado.id, {
        name: 'Boda de Ana',
        venue: null,
        weddingDate: new Date('2027-01-01T00:00:00Z'),
      })
      resultados.push(sinVolatiles({ ...actualizado }))
    }
    expect(resultados[0]).toMatchObject({
      name: 'Boda de Ana',
      venue: null,
      totalBudget: '100.00',
      weddingDate: new Date('2027-01-01T00:00:00Z'),
    })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('actualizar un evento inexistente lanza EventoNoEncontradoError', async () => {
    for (const [, repo] of sujetos()) {
      await expect(
        repo.actualizar('00000000-0000-4000-8000-000000000000', { name: 'X' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
  })
})
```

Este fichero cubre el doble y Prisma en los mismos casos. La regla VENDOR/DRAFT se prueba contra Postgres en el e2e de la Tarea 8. En el doble, la prueba va en `event-access.service.test.ts` (Step 2).

- [ ] **Step 2: Test del doble para VENDOR y DRAFT**

Añadir a `src/modules/events/application/event-access.service.test.ts`, siguiendo la siembra existente del fichero (`repo.eventos.push`, `repo.perfiles.push`, `repo.eventVendors.push`):

```ts
  it('un vendor BOOKED en un evento DRAFT no tiene acceso', async () => {
    const repo = new EventRepositoryEnMemoria()
    repo.eventos.push({ id: EVENTO, ownerId: 'pareja', status: 'DRAFT' })
    repo.perfiles.push({ id: 'perfil-1', userId: 'vendor-1' })
    repo.eventVendors.push({ id: 'ev-1', eventId: EVENTO, vendorProfileId: 'perfil-1', status: 'BOOKED' })

    expect(await repo.buscarContratacionReservada(EVENTO, 'vendor-1')).toBeNull()
    expect(await repo.listarAccesiblesPor('vendor-1')).toEqual([])
  })
```

Si el fichero no define `EVENTO`, se usa `'11111111-1111-4111-8111-111111111111'`.

- [ ] **Step 3: Ejecutar**

Run: `npx vitest run src/modules/events`
Expected: FAIL (errores de tipos y `actualizar is not a function`).

- [ ] **Step 4: Implementar el puerto**

En `src/modules/events/application/event.repository.ts`, sustituir `DatosNuevoEvento` por el de *Produces*, añadir `CambiosEvento` y el método:

```ts
  /**
   * Actualización parcial: `undefined` = no tocar, `null` = borrar. La regla
   * de "un ACTIVE no puede quedar incompleto" NO vive aquí: la aplica el caso
   * de uso antes de llamar. Lanza `EventoNoEncontradoError` si no existe.
   */
  actualizar(eventId: string, cambios: CambiosEvento): Promise<Event>
```

Actualizar el docblock de `buscarContratacionReservada`: "BOOKED en un evento ACTIVE: un borrador no se enseña a proveedores".

Imports: `import type { Ubicacion } from '@/shared/domain'` y `import type { Event, EventStatus } from '../domain/event'`.

- [ ] **Step 5: Implementar el adaptador Prisma**

En `prisma-event.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'
import type { Event as EventFila, Prisma } from '@prisma/client'

import { clienteDe } from '@/modules/database/transaccion'
import { PrismaService } from '@/modules/database/prisma.service'
import type { Ubicacion } from '@/shared/domain'
// ...imports existentes...
import { EventoNoEncontradoError } from '../domain/event-errors'

/** Conteos que alimentan `completitud` sin una consulta por evento. */
const CON_CONTEOS = {
  _count: { select: { scheduleItems: true, vendors: true } },
} satisfies Prisma.EventInclude

type FilaConConteos = EventFila & { _count: { scheduleItems: number; vendors: number } }

/** `undefined` no toca las columnas; `null` las vacía las cinco a la vez. */
function columnasVenue(venue: Ubicacion | null | undefined): Prisma.EventUncheckedUpdateInput {
  if (venue === undefined) return {}
  if (venue === null) {
    return { venueName: null, venueAddress: null, venueLat: null, venueLng: null, venueMapboxId: null }
  }
  return {
    venueName: venue.name,
    venueAddress: venue.address,
    venueLat: venue.lat,
    venueLng: venue.lng,
    venueMapboxId: venue.mapboxId,
  }
}
```

`crearConMembresia`, dentro de la transacción existente, con `data` ampliado:

```ts
      const evento = await tx.event.create({
        data: {
          name: datos.name,
          ownerId: datos.ownerId,
          ...(datos.weddingDate !== undefined ? { weddingDate: datos.weddingDate } : {}),
          ...(datos.timezone !== undefined ? { timezone: datos.timezone } : {}),
          ...(datos.currency !== undefined ? { currency: datos.currency } : {}),
          ...(datos.totalBudget !== undefined ? { totalBudget: datos.totalBudget } : {}),
          ...(columnasVenue(datos.venue) as Prisma.EventUncheckedCreateInput),
          ...(datos.rsvpDeadlineDays !== undefined
            ? { rsvpDeadlineDays: datos.rsvpDeadlineDays }
            : {}),
        },
        include: CON_CONTEOS,
      })
```

La membresía COUPLE no cambia. Devuelve `this.aDominio(evento)`.

`actualizar`:

```ts
  async actualizar(eventId: string, cambios: CambiosEvento): Promise<Event> {
    // `updateMany` + relectura: un `update` sobre un id inexistente lanza
    // P2025 crudo (500); así el 404 es de dominio.
    const cliente = clienteDe(this.prisma)
    const { count } = await cliente.event.updateMany({
      where: { id: eventId },
      data: {
        ...(cambios.name !== undefined ? { name: cambios.name } : {}),
        ...(cambios.status !== undefined ? { status: cambios.status } : {}),
        ...(cambios.weddingDate !== undefined ? { weddingDate: cambios.weddingDate } : {}),
        ...(cambios.timezone !== undefined ? { timezone: cambios.timezone } : {}),
        ...(cambios.currency !== undefined ? { currency: cambios.currency } : {}),
        ...(cambios.totalBudget !== undefined ? { totalBudget: cambios.totalBudget } : {}),
        ...(columnasVenue(cambios.venue) as Prisma.EventUpdateManyMutationInput),
      },
    })
    if (count === 0) throw new EventoNoEncontradoError()
    const fila = await cliente.event.findUnique({ where: { id: eventId }, include: CON_CONTEOS })
    if (fila === null) throw new EventoNoEncontradoError()
    return this.aDominio(fila)
  }
```

`buscarContratacionReservada`: `where: { eventId, status: CONTRATACION_CON_ACCESO, vendorProfile: { userId }, event: { status: 'ACTIVE' } }`.

`listarAccesiblesPor`:

```ts
    const filas = await this.prisma.event.findMany({
      where: {
        OR: [
          { memberships: { some: { userId, status: MEMBRESIA_CON_ACCESO } } },
          {
            status: 'ACTIVE',
            vendors: { some: { status: CONTRATACION_CON_ACCESO, vendorProfile: { userId } } },
          },
        ],
      },
      include: CON_CONTEOS,
      // Borradores sin fecha al final; `createdAt` desempata de forma estable.
      orderBy: [{ weddingDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }],
    })
```

`buscarPorId`: `findUnique({ where: { id: eventId }, include: CON_CONTEOS })`.

`aDominio`:

```ts
  private aDominio(fila: FilaConConteos): Event {
    const tieneVenue =
      fila.venueAddress !== null && fila.venueLat !== null && fila.venueLng !== null
    return {
      id: fila.id,
      name: fila.name,
      status: fila.status,
      weddingDate: fila.weddingDate,
      timezone: fila.timezone,
      currency: fila.currency,
      totalBudget: fila.totalBudget === null ? null : fila.totalBudget.toFixed(2),
      // Una dirección sin coordenadas (la migrada de `venueLocation`) no es un
      // venue publicable: se expone como null y el wizard pide elegirla en el mapa.
      venue: tieneVenue
        ? {
            name: fila.venueName,
            address: fila.venueAddress ?? '',
            lat: Number(fila.venueLat),
            lng: Number(fila.venueLng),
            mapboxId: fila.venueMapboxId,
          }
        : null,
      rsvpDeadlineDays: fila.rsvpDeadlineDays,
      ownerId: fila.ownerId,
      conteos: { scheduleItems: fila._count.scheduleItems, vendors: fila._count.vendors },
      createdAt: fila.createdAt,
      updatedAt: fila.updatedAt,
    }
  }
```

Hay un caso límite: un evento migrado tiene `venueAddress` sin coordenadas y su `venue` sale como `null`. Si ese evento es `ACTIVE`, cualquier PATCH que no aporte `venue` daría 422 `faltantes: ['venue']`. Por eso el caso de uso de la Tarea 7 compara los faltantes de antes y de después del parche y solo rechaza los **nuevos**. Queda anotado aquí para quien lo implemente.

- [ ] **Step 6: Implementar el doble**

En `event.repository.fake.ts`:

```ts
export interface EventoEnMemoria {
  id: string
  ownerId: string
  name?: string
  /** Sembrado a mano = evento ya publicado; `crearConMembresia` crea DRAFT. */
  status?: EventStatus
  weddingDate?: Date | null
  timezone?: string
  currency?: string
  totalBudget?: string | null
  venue?: Ubicacion | null
  rsvpDeadlineDays?: number
  conteos?: ConteosEvento
  createdAt?: Date
}
```

`crearConMembresia`:

```ts
    const evento: EventoEnMemoria = {
      id: randomUUID(),
      ownerId: datos.ownerId,
      name: datos.name,
      status: 'DRAFT',
      weddingDate: datos.weddingDate ?? null,
      timezone: datos.timezone ?? 'UTC',
      currency: datos.currency ?? 'USD',
      totalBudget: datos.totalBudget ?? null,
      venue: datos.venue ?? null,
      rsvpDeadlineDays: datos.rsvpDeadlineDays ?? DIAS_DE_CIERRE_POR_DEFECTO,
      conteos: { scheduleItems: 0, vendors: 0 },
      createdAt: new Date(),
    }
```

`actualizar`:

```ts
  actualizar(eventId: string, cambios: CambiosEvento): Promise<Event> {
    const evento = this.eventos.find((e) => e.id === eventId)
    if (evento === undefined) return Promise.reject(new EventoNoEncontradoError())
    // `undefined` = no tocar; `null` = borrar. Igual que el `updateMany` de Prisma.
    for (const clave of Object.keys(cambios) as Array<keyof CambiosEvento>) {
      const valor = cambios[clave]
      if (valor !== undefined) Object.assign(evento, { [clave]: valor })
    }
    return Promise.resolve(this.materializar(evento))
  }
```

`buscarContratacionReservada` y `listarAccesiblesPor`: una contratación solo cuenta si el evento está `ACTIVE`, donde `status` ausente cuenta como `ACTIVE`:

```ts
  private estaActivo(eventId: string): boolean {
    return (this.eventos.find((e) => e.id === eventId)?.status ?? 'ACTIVE') === 'ACTIVE'
  }
```

Hay que añadir `&& this.estaActivo(v.eventId)` / `&& this.estaActivo(eventId)` en los filtros de contratación.

`materializar` devuelve la forma completa de `Event`:

```ts
    return {
      id: evento.id,
      name: evento.name ?? 'Evento de prueba',
      status: evento.status ?? 'ACTIVE',
      weddingDate:
        evento.weddingDate === undefined
          ? new Date(Date.now() + 180 * 86_400_000)
          : evento.weddingDate,
      timezone: evento.timezone ?? 'UTC',
      currency: evento.currency ?? 'USD',
      totalBudget: evento.totalBudget ?? null,
      venue: evento.venue ?? null,
      rsvpDeadlineDays: evento.rsvpDeadlineDays ?? DIAS_DE_CIERRE_POR_DEFECTO,
      ownerId: evento.ownerId,
      conteos: evento.conteos ?? { scheduleItems: 0, vendors: 0 },
      createdAt: evento.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }
```

Nota de paridad: el test compara `sinVolatiles` y excluye `createdAt`/`updatedAt`.

- [ ] **Step 7: Compilación provisional del controlador y del caso de uso de creación**

`create-event.use-case.ts`: `export type DatosCrearEvento = DatosNuevoEvento` (se reexporta el tipo del puerto). Se mantiene el docblock.

`events.controller.ts`: `aRespuesta(evento: Event)` pasa a devolver `{ id, name, status, weddingDate: evento.weddingDate?.toISOString() ?? null, timezone, currency, totalBudget, venue, rsvpDeadlineDays, ownerId }`. La forma definitiva llega en la Tarea 8.

- [ ] **Step 8: Ejecutar**

Run: `npm run typecheck && npx vitest run src/modules/events`
Expected: PASS (paridad incluida, con Docker).

- [ ] **Step 9: Commit (Tareas 5 y 6)**

```bash
git add src/modules/events
git commit -m "feat: eventos en borrador con lugar, moneda y presupuesto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Casos de uso crear, actualizar y publicar

**Files:**
- Modify: `src/modules/events/application/create-event.use-case.ts`
- Create: `src/modules/events/application/create-event.use-case.test.ts`
- Create: `src/modules/events/application/update-event.use-case.ts` y `update-event.use-case.test.ts`
- Create: `src/modules/events/application/publish-event.use-case.ts` y `publish-event.use-case.test.ts`

**Interfaces:**
- Consumes: `EventRepository.crearConMembresia/actualizar/buscarPorId`, `camposFaltantesParaPublicar` y `EventoIncompletoError`.
- Produces:
  - `CreateEventUseCase.ejecutar(datos: DatosCrearEvento): Promise<Event>`
  - `UpdateEventUseCase.ejecutar(eventId: string, cambios: CambiosEvento): Promise<Event>`
  - `PublishEventUseCase.ejecutar(eventId: string): Promise<Event>`

- [ ] **Step 1: Tests que fallan**

`update-event.use-case.test.ts`:

```ts
import { EventoIncompletoError, EventoNoEncontradoError } from '../domain/event-errors'
import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'
import { UpdateEventUseCase } from './update-event.use-case'

const VENUE = { name: null, address: 'Calle 1', lat: 4.6, lng: -74.1, mapboxId: null }

function eventoActivo(repo: EventRepositoryEnMemoria, extra: object = {}): string {
  const id = '11111111-1111-4111-8111-111111111111'
  repo.eventos.push({
    id,
    ownerId: 'ana',
    status: 'ACTIVE',
    name: 'Boda',
    weddingDate: new Date('2027-06-12T00:00:00Z'),
    currency: 'USD',
    totalBudget: '100.00',
    venue: VENUE,
    ...extra,
  })
  return id
}

describe('UpdateEventUseCase', () => {
  it('en un borrador acepta dejar campos vacíos', async () => {
    const repo = new EventRepositoryEnMemoria()
    const creado = await repo.crearConMembresia({ name: 'Boda', ownerId: 'ana', totalBudget: '10.00' })
    const caso = new UpdateEventUseCase(repo)

    const evento = await caso.ejecutar(creado.id, { totalBudget: null, weddingDate: null })

    expect(evento).toMatchObject({ status: 'DRAFT', totalBudget: null, weddingDate: null })
  })

  it('en un ACTIVE permite cambiarlo todo, moneda incluida', async () => {
    const repo = new EventRepositoryEnMemoria()
    const id = eventoActivo(repo)
    const caso = new UpdateEventUseCase(repo)

    const evento = await caso.ejecutar(id, {
      name: 'Boda de Ana',
      currency: 'COP',
      totalBudget: '4500000.00',
      venue: { ...VENUE, address: 'Calle 2' },
    })

    expect(evento).toMatchObject({ name: 'Boda de Ana', currency: 'COP', totalBudget: '4500000.00' })
  })

  it('en un ACTIVE rechaza vaciar el venue con 422 y no persiste nada', async () => {
    const repo = new EventRepositoryEnMemoria()
    const id = eventoActivo(repo)
    const caso = new UpdateEventUseCase(repo)

    const error = await caso.ejecutar(id, { venue: null, name: 'Otro' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EventoIncompletoError)
    expect((error as EventoIncompletoError).details).toEqual({ faltantes: ['venue'] })
    expect((await repo.buscarPorId(id))?.name).toBe('Boda')
  })

  it('en un ACTIVE que ya venía sin venue (migrado) deja editar otros campos', async () => {
    const repo = new EventRepositoryEnMemoria()
    const id = eventoActivo(repo, { venue: null })
    const caso = new UpdateEventUseCase(repo)

    await expect(caso.ejecutar(id, { name: 'Nuevo' })).resolves.toMatchObject({ name: 'Nuevo' })
  })

  it('evento inexistente → 404', async () => {
    const caso = new UpdateEventUseCase(new EventRepositoryEnMemoria())
    await expect(
      caso.ejecutar('00000000-0000-4000-8000-000000000000', { name: 'X' }),
    ).rejects.toBeInstanceOf(EventoNoEncontradoError)
  })
})
```

`publish-event.use-case.test.ts`:

```ts
import { EventoIncompletoError } from '../domain/event-errors'
import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'
import { PublishEventUseCase } from './publish-event.use-case'

const VENUE = { name: null, address: 'Calle 1', lat: 4.6, lng: -74.1, mapboxId: null }

describe('PublishEventUseCase', () => {
  it('rechaza un borrador incompleto con la lista de faltantes', async () => {
    const repo = new EventRepositoryEnMemoria()
    const creado = await repo.crearConMembresia({ name: 'Boda', ownerId: 'ana' })

    const error = await new PublishEventUseCase(repo).ejecutar(creado.id).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EventoIncompletoError)
    expect((error as EventoIncompletoError).details).toEqual({
      faltantes: ['weddingDate', 'totalBudget', 'venue'],
    })
    expect((await repo.buscarPorId(creado.id))?.status).toBe('DRAFT')
  })

  it('publica un borrador completo', async () => {
    const repo = new EventRepositoryEnMemoria()
    const creado = await repo.crearConMembresia({
      name: 'Boda',
      ownerId: 'ana',
      weddingDate: new Date('2027-06-12T00:00:00Z'),
      totalBudget: '0.00',
      venue: VENUE,
    })

    const evento = await new PublishEventUseCase(repo).ejecutar(creado.id)

    expect(evento.status).toBe('ACTIVE')
  })

  it('publicar un ACTIVE es idempotente', async () => {
    const repo = new EventRepositoryEnMemoria()
    repo.eventos.push({ id: '11111111-1111-4111-8111-111111111111', ownerId: 'ana', status: 'ACTIVE' })

    const evento = await new PublishEventUseCase(repo).ejecutar('11111111-1111-4111-8111-111111111111')

    expect(evento.status).toBe('ACTIVE')
  })
})
```

`create-event.use-case.test.ts`:

```ts
import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'
import { CreateEventUseCase } from './create-event.use-case'

describe('CreateEventUseCase', () => {
  it('crea un borrador solo con nombre y el creador es COUPLE', async () => {
    const repo = new EventRepositoryEnMemoria()
    const evento = await new CreateEventUseCase(repo).ejecutar({ name: 'Boda', ownerId: 'ana' })

    expect(evento).toMatchObject({ name: 'Boda', status: 'DRAFT', weddingDate: null })
    expect(await repo.buscarMembresiaActiva(evento.id, 'ana')).toEqual({ role: 'COUPLE' })
  })
})
```

- [ ] **Step 2: Ejecutar**

Run: `npx vitest run src/modules/events/application`
Expected: FAIL (no existen `UpdateEventUseCase` ni `PublishEventUseCase`).

- [ ] **Step 3: Implementar**

`update-event.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'

import type { Event } from '../domain/event'
import { EventoIncompletoError, EventoNoEncontradoError } from '../domain/event-errors'
import { camposFaltantesParaPublicar } from '../domain/publicacion'
import { type CambiosEvento, EVENT_REPOSITORY, type EventRepository } from './event.repository'

@Injectable()
export class UpdateEventUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  /**
   * Un evento es editable en CUALQUIER estado (decisión del usuario). La única
   * guarda: un ACTIVE no puede quedar sin algo que antes tenía y que hace falta
   * para estar publicado. Se comparan los faltantes de antes y de después para
   * no bloquear la edición de eventos migrados que ya venían sin coordenadas.
   */
  async ejecutar(eventId: string, cambios: CambiosEvento): Promise<Event> {
    const actual = await this.eventos.buscarPorId(eventId)
    if (actual === null) throw new EventoNoEncontradoError()

    if (actual.status === 'ACTIVE') {
      const antes = new Set(camposFaltantesParaPublicar(actual))
      const despues = camposFaltantesParaPublicar({
        name: cambios.name ?? actual.name,
        weddingDate: cambios.weddingDate !== undefined ? cambios.weddingDate : actual.weddingDate,
        timezone: cambios.timezone ?? actual.timezone,
        currency: cambios.currency ?? actual.currency,
        totalBudget: cambios.totalBudget !== undefined ? cambios.totalBudget : actual.totalBudget,
        venue: cambios.venue !== undefined ? cambios.venue : actual.venue,
      })
      const nuevos = despues.filter((campo) => !antes.has(campo))
      if (nuevos.length > 0) throw new EventoIncompletoError(nuevos)
    }

    return await this.eventos.actualizar(eventId, cambios)
  }
}
```

`publish-event.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'

import type { Event } from '../domain/event'
import { EventoIncompletoError, EventoNoEncontradoError } from '../domain/event-errors'
import { camposFaltantesParaPublicar } from '../domain/publicacion'
import { EVENT_REPOSITORY, type EventRepository } from './event.repository'

@Injectable()
export class PublishEventUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  /** DRAFT → ACTIVE. Sobre un ACTIVE no hace nada: reintentar no es un error. */
  async ejecutar(eventId: string): Promise<Event> {
    const actual = await this.eventos.buscarPorId(eventId)
    if (actual === null) throw new EventoNoEncontradoError()
    if (actual.status === 'ACTIVE') return actual

    const faltantes = camposFaltantesParaPublicar(actual)
    if (faltantes.length > 0) throw new EventoIncompletoError(faltantes)

    return await this.eventos.actualizar(eventId, { status: 'ACTIVE' })
  }
}
```

`create-event.use-case.ts`: `export type DatosCrearEvento = DatosNuevoEvento`, importado del puerto. El cuerpo no cambia. Actualizar el docblock: "Nace en DRAFT; solo `name` es obligatorio".

Registrar `UpdateEventUseCase` y `PublishEventUseCase` en `providers` de `events.module.ts`.

- [ ] **Step 4: Ejecutar**

Run: `npx vitest run src/modules/events && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/events
git commit -m "feat: casos de uso para editar y publicar eventos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: API de eventos (DTO, controlador y e2e)

**Files:**
- Modify: `src/modules/events/interfaces/events.dto.ts`
- Modify: `src/modules/events/interfaces/events.controller.ts`
- Create: `src/modules/events/interfaces/events.dto.test.ts`
- Create: `test/support/eventos.ts`
- Create: `test/e2e/events-draft.e2e.test.ts`
- Modify: `test/e2e/event-vendors.e2e.test.ts`, `test/e2e/event-access.e2e.test.ts` y `test/e2e/guests.e2e.test.ts`

**Interfaces:**
- Consumes: los casos de uso de la Tarea 7, `normalizarMonto`, `crearUbicacion`, `MONEDAS` y `completitud`.
- Produces:
  - Esquemas `montoSchema` y `ubicacionSchema`, exportados desde `events.dto.ts` y reutilizados en schedule, expenses y vendors. Son de `interfaces/`, así que para esos módulos se copian a `src/shared/http/esquemas.ts` (ver Step 3): un módulo no importa las interfaces de otro de forma cómoda. La fuente única es `src/shared/http/esquemas.ts`.
  - Respuesta `EventoRespuesta`:

```ts
{ id: string; name: string; status: 'DRAFT' | 'ACTIVE'; weddingDate: string | null;
  timezone: string; currency: string; totalBudget: string | null; venue: Ubicacion | null;
  completitud: Completitud; rsvpDeadlineDays: number; ownerId: string;
  createdAt: string; updatedAt: string }
```

  - Rutas: `POST /events` (201), `PATCH /events/:eventId` (200) y `POST /events/:eventId/publish` (200), los dos últimos para COUPLE y PLANNER. `GET /events/:eventId` para un VENDOR sobre un DRAFT → 404.
  - Helper `crearEventoPublicado(url: string, accessToken: string, name: string): Promise<string>`.

- [ ] **Step 1: Tests de DTO que fallan**

`src/modules/events/interfaces/events.dto.test.ts`:

```ts
import { createEventSchema, updateEventSchema } from './events.dto'

describe('createEventSchema', () => {
  it('solo el nombre es obligatorio', () => {
    expect(createEventSchema.parse({ name: ' Boda ' })).toEqual({ name: 'Boda' })
  })

  it('normaliza el presupuesto y valida moneda y zona horaria', () => {
    const datos = createEventSchema.parse({
      name: 'Boda',
      totalBudget: 1500,
      currency: 'COP',
      timezone: 'America/Bogota',
      weddingDate: '2027-06-12',
    })
    expect(datos.totalBudget).toBe('1500.00')
    expect(datos.weddingDate).toEqual(new Date('2027-06-12T00:00:00.000Z'))
  })

  it.each([
    [{ name: '' }],
    [{ name: 'B', currency: 'XXX' }],
    [{ name: 'B', timezone: 'Mars/Olympus' }],
    [{ name: 'B', totalBudget: '1,500' }],
    [{ name: 'B', totalBudget: -1 }],
    [{ name: 'B', venue: { address: 'X', lat: 100, lng: 0 } }],
  ])('rechaza %o', (entrada) => {
    expect(createEventSchema.safeParse(entrada).success).toBe(false)
  })
})

describe('updateEventSchema', () => {
  it('exige al menos un cambio', () => {
    expect(updateEventSchema.safeParse({}).success).toBe(false)
  })

  it('acepta null para borrar venue, fecha y presupuesto', () => {
    expect(updateEventSchema.parse({ venue: null, weddingDate: null, totalBudget: null })).toEqual({
      venue: null,
      weddingDate: null,
      totalBudget: null,
    })
  })

  it('no acepta cambiar el estado por PATCH', () => {
    expect(updateEventSchema.safeParse({ status: 'ACTIVE' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Ejecutar**

Run: `npx vitest run src/modules/events/interfaces/events.dto.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar los esquemas compartidos y los DTO**

`src/shared/http/esquemas.ts`:

```ts
import { z } from 'zod'

import { crearUbicacion, MontoInvalidoError, normalizarMonto } from '@/shared/domain'

/**
 * Monto de entrada: number o string. Sale como string normalizado ("1500.00").
 * El error de formato es un 400 de Zod, no el 422 del value object: aquí el
 * problema es la forma de la petición.
 */
export const montoSchema = z.union([z.number(), z.string()]).transform((valor, ctx) => {
  try {
    return normalizarMonto(valor)
  } catch (error) {
    if (!(error instanceof MontoInvalidoError)) throw error
    ctx.addIssue({ code: 'custom', message: error.message })
    return z.NEVER
  }
})

export const ubicacionSchema = z
  .object({
    name: z.string().trim().max(200).nullable().optional(),
    address: z.string().trim().min(1).max(500),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    mapboxId: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .transform((entrada) => crearUbicacion(entrada))

/** `YYYY-MM-DD` o ISO completo → Date. */
export const fechaSchema = z.coerce.date()
```

`src/modules/events/interfaces/events.dto.ts`:

```ts
import { z } from 'zod'

import { fechaSchema, montoSchema, ubicacionSchema } from '@/shared/http/esquemas'

import { MONEDAS } from '../domain/moneda'

/** 'UTC' no siempre está en `supportedValuesOf`, pero es el default de la columna. */
const ZONAS = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])

const timezoneSchema = z
  .string()
  .trim()
  .refine((tz) => ZONAS.has(tz), { message: 'Zona horaria desconocida' })

const camposEditables = {
  weddingDate: fechaSchema.nullable().optional(),
  timezone: timezoneSchema.optional(),
  currency: z.enum(MONEDAS).optional(),
  totalBudget: montoSchema.nullable().optional(),
  venue: ubicacionSchema.nullable().optional(),
}

export const createEventSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    rsvpDeadlineDays: z.number().int().min(0).max(365).optional(),
    ...camposEditables,
  })
  .strict()
export type CreateEventDto = z.infer<typeof createEventSchema>

/**
 * `status` NO se acepta aquí: publicar tiene su propia ruta, con su propia
 * validación. Así un PATCH nunca publica ni despublica por accidente.
 */
export const updateEventSchema = z
  .object({ name: z.string().trim().min(1).max(200).optional(), ...camposEditables })
  .strict()
  .refine((datos) => Object.keys(datos).length > 0, { message: 'Indica al menos un cambio' })
export type UpdateEventDto = z.infer<typeof updateEventSchema>

// inviteMemberSchema: sin cambios.
```

Con `.strict()`, `{ status: 'ACTIVE' }` da error de clave desconocida, que es lo que pide el test. Si alguna ruta actual manda claves extra al crear eventos, el e2e lo va a detectar en el Step 7.

- [ ] **Step 4: Controlador**

Cambios en `events.controller.ts`:
- Constructor: `private readonly editar: UpdateEventUseCase` y `private readonly publicar: PublishEventUseCase`.
- `aRespuesta(evento: Event): EventoRespuesta`:

```ts
  private aRespuesta(evento: Event): EventoRespuesta {
    return {
      id: evento.id,
      name: evento.name,
      status: evento.status,
      weddingDate: evento.weddingDate?.toISOString() ?? null,
      timezone: evento.timezone,
      currency: evento.currency,
      totalBudget: evento.totalBudget,
      venue: evento.venue,
      completitud: completitud(evento),
      rsvpDeadlineDays: evento.rsvpDeadlineDays,
      ownerId: evento.ownerId,
      createdAt: evento.createdAt.toISOString(),
      updatedAt: evento.updatedAt.toISOString(),
    }
  }
```

- `verEvento`: después de resolver el evento, `if (evento.status === 'DRAFT' && acceso.kind === 'vendor') throw new EventoNoEncontradoError()`. Se comprueba el nombre del discriminante real en `src/modules/events/domain/event-access.ts`, que tiene la unión admin/member/vendor/none, y se usa ese campo. Es una defensa en profundidad: el guard ya lo niega por el repositorio.
- Rutas nuevas:

```ts
  @UseGuards(EventAccessGuard)
  @RequireEventAccess('COUPLE', 'PLANNER')
  @Patch(':eventId')
  async editarEvento(
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<EventoRespuesta> {
    const cambios = validarCon(updateEventSchema, body)
    return this.aRespuesta(await this.editar.ejecutar(eventId, cambios))
  }

  @UseGuards(EventAccessGuard)
  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post(':eventId/publish')
  @HttpCode(200)
  async publicarEvento(@Param('eventId') eventId: string): Promise<EventoRespuesta> {
    return this.aRespuesta(await this.publicar.ejecutar(eventId))
  }
```

Imports: `HttpCode` y `Patch` de `@nestjs/common`, `completitud`, `Event` y los dos casos de uso.

`validarCon` devuelve el tipo inferido del esquema. Con `exactOptionalPropertyTypes`, si TypeScript protesta al pasar `UpdateEventDto` como `CambiosEvento`, el tipo inferido lleva `?: T | undefined` y el puerto ya declara `| undefined`, así que es compatible.

- [ ] **Step 5: Helper e2e**

`test/support/eventos.ts`:

```ts
import request from 'supertest'

/**
 * Crea un evento completo y lo publica. Los e2e que prueban invitados,
 * vendors o accesos parten de un evento ACTIVE: un borrador no se enseña a
 * proveedores y no es lo que esos tests quieren ejercitar.
 */
export async function crearEventoPublicado(
  url: string,
  accessToken: string,
  name: string,
): Promise<string> {
  const creado = await request(url)
    .post('/events')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      name,
      weddingDate: '2027-06-12T00:00:00.000Z',
      timezone: 'America/Bogota',
      currency: 'USD',
      totalBudget: 10000,
      venue: { name: 'Hacienda', address: 'Km 5 vía La Calera', lat: 4.7, lng: -73.9 },
    })
    .expect(201)
  const id = (creado.body as { id: string }).id
  await request(url)
    .post(`/events/${id}/publish`)
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200)
  return id
}
```

En `test/e2e/event-vendors.e2e.test.ts`, `event-access.e2e.test.ts` y `guests.e2e.test.ts`, cada `.post('/events')...send({ name, weddingDate })` pasa a `await crearEventoPublicado(url, token, name)`. Son 6 llamadas en total: `event-vendors:78`, `event-access:66,161,166,193` y `guests:87`. Si alguna de ellas comprueba la forma de la respuesta del POST (p. ej. `event-access:193`), se revisa ese test concreto: si afirma algo del cuerpo, se deja el POST directo y se ajusta la aserción a la respuesta nueva, con `status: 'DRAFT'` y `weddingDate`.

- [ ] **Step 6: e2e nuevo**

`test/e2e/events-draft.e2e.test.ts` usa el mismo arranque que `event-vendors.e2e.test.ts`: se copian literalmente `beforeAll`/`afterAll` y `registrarYEntrar` de ese fichero. Los casos:

```ts
  it('crea un borrador solo con nombre', async () => {
    const res = await request(url)
      .post('/events')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Boda borrador' })
      .expect(201)
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      weddingDate: null,
      currency: 'USD',
      totalBudget: null,
      venue: null,
      completitud: { general: 'parcial', venue: 'vacio', schedule: 'vacio', budget: 'vacio' },
    })
  })

  it('PATCH parcial y publish con faltantes → 422 con details', async () => {
    const { body } = await request(url)
      .post('/events')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Boda' })
      .expect(201)
    const id = (body as { id: string }).id

    await request(url)
      .patch(`/events/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ totalBudget: '2500.5' })
      .expect(200)
      .expect((r) => expect((r.body as { totalBudget: string }).totalBudget).toBe('2500.50'))

    const fallo = await request(url)
      .post(`/events/${id}/publish`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(422)
    expect(fallo.body).toMatchObject({
      code: 'EVENT_INCOMPLETE',
      details: { faltantes: ['weddingDate', 'venue'] },
    })
  })

  it('un ACTIVE se edita entero, moneda incluida, pero no se puede vaciar el venue', async () => {
    const id = await crearEventoPublicado(url, ana.accessToken, 'Boda publicada')

    await request(url)
      .patch(`/events/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Renombrada', currency: 'EUR', weddingDate: '2027-07-01' })
      .expect(200)
      .expect((r) => expect(r.body).toMatchObject({ name: 'Renombrada', currency: 'EUR', status: 'ACTIVE' }))

    const fallo = await request(url)
      .patch(`/events/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ venue: null })
      .expect(422)
    expect(fallo.body).toMatchObject({ details: { faltantes: ['venue'] } })
  })

  it.each([[{ totalBudget: '1,500' }], [{ totalBudget: 1e21 }], [{}], [{ status: 'ACTIVE' }]])(
    'PATCH con %o → 400',
    async (cuerpo) => {
      const id = await crearEventoPublicado(url, ana.accessToken, 'Boda 400')
      await request(url)
        .patch(`/events/${id}`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send(cuerpo)
        .expect(400)
    },
  )

  it('un extraño recibe 404 en PATCH y publish', async () => {
    const id = await crearEventoPublicado(url, ana.accessToken, 'Boda ajena')
    await request(url)
      .patch(`/events/${id}`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .send({ name: 'X' })
      .expect(404)
    await request(url)
      .post(`/events/${id}/publish`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)
  })

  it('un vendor BOOKED no ve el borrador; sí lo ve cuando se publica', async () => {
    const { body } = await request(url)
      .post('/events')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({
        name: 'Boda con fotógrafo',
        weddingDate: '2027-06-12',
        totalBudget: 1,
        venue: { address: 'Calle 1', lat: 1, lng: 1 },
      })
      .expect(201)
    const id = (body as { id: string }).id
    const perfil = await prisma.vendorProfile.create({
      data: { userId: fotografo.id, businessName: 'Luz', category: 'Photo', status: 'PUBLISHED' },
    })
    await prisma.eventVendor.create({
      data: { eventId: id, vendorProfileId: perfil.id, category: 'Photo', status: 'BOOKED' },
    })

    await request(url).get(`/events/${id}`).set('Authorization', `Bearer ${fotografo.accessToken}`).expect(404)
    const lista = await request(url).get('/events').set('Authorization', `Bearer ${fotografo.accessToken}`).expect(200)
    expect((lista.body as Array<{ id: string }>).map((e) => e.id)).not.toContain(id)

    await request(url).post(`/events/${id}/publish`).set('Authorization', `Bearer ${ana.accessToken}`).expect(200)
    await request(url).get(`/events/${id}`).set('Authorization', `Bearer ${fotografo.accessToken}`).expect(200)
  })
```

Las variables `ana`, `extrano` y `fotografo` se crean en `beforeAll` con `registrarYEntrar`, como en `event-vendors.e2e.test.ts`.

- [ ] **Step 7: Ejecutar**

Run: `npx vitest run src/modules/events test/e2e/events-draft.e2e.test.ts test/e2e/event-vendors.e2e.test.ts test/e2e/event-access.e2e.test.ts test/e2e/guests.e2e.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/shared/http/esquemas.ts src/modules/events test
git commit -m "feat: endpoints para editar y publicar eventos en borrador

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Proveedores del evento: montos en string, nombre visible y 409 con gastos

**Files:**
- Modify: `src/modules/vendors/application/event-vendor.repository.ts`
- Modify: `src/modules/vendors/application/add-event-vendor.use-case.ts`, `remove-event-vendor.use-case.ts` y sus tests (incluidos `update-`/`list-` por el tipo del monto)
- Modify: `src/modules/vendors/domain/vendor-errors.ts`
- Modify: `src/modules/vendors/infrastructure/prisma-event-vendor.repository.ts` y `event-vendor.repository.fake.ts`
- Modify: `src/modules/vendors/interfaces/event-vendor.dto.ts` y `event-vendors.controller.ts`
- Modify: `test/e2e/event-vendors.e2e.test.ts`

**Interfaces:**
- Produces:
  - `EventVendorVista.assignedBudget: string | null`.
  - `EventVendorVista.name: string`: `businessName` de la ficha si está vinculada y `externalName` si es externo.
  - `EventVendorRepository.tieneGastos(eventId: string, eventVendorId: string): Promise<boolean>`.
  - `ProveedorConGastosError` (409, `VENDOR_HAS_EXPENSES`).
  - Respuesta HTTP: añade `name` y `assignedBudget: string | null`.
  - `PerfilPublicadoEnMemoria.businessName?: string`, y el doble `EventVendorRepositoryEnMemoria.gastos: Array<{ eventId: string; eventVendorId: string }>`.

- [ ] **Step 1: Tests que fallan**

En `remove-event-vendor.use-case.test.ts`:

```ts
  it('rechaza eliminar un proveedor con gastos registrados (409)', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new RemoveEventVendorUseCase(vendors)
    const vista = await vendors.crear({
      eventId: EVENTO,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: null, phone: null },
      category: 'Floristería',
      specialty: null,
      assignedBudget: '1500.00',
      actorUserId: 'ana',
    })
    vendors.gastos.push({ eventId: EVENTO, eventVendorId: vista.id })

    await expect(caso.ejecutar(EVENTO, vista.id, 'ana')).rejects.toBeInstanceOf(
      ProveedorConGastosError,
    )
    expect(await vendors.buscarPorId(EVENTO, vista.id)).not.toBeNull()
  })
```

En `add-event-vendor.use-case.test.ts`, crear el fichero si no existe siguiendo el patrón de los otros:

```ts
  it('devuelve el nombre visible: el de la ficha o el externo', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    vendors.perfiles.push({ id: PERFIL, status: 'PUBLISHED', businessName: 'Lumière' })
    const caso = new AddEventVendorUseCase(vendors)

    const vinculado = await caso.ejecutar(EVENTO, {
      vendorProfileId: PERFIL,
      category: 'Catering',
      assignedBudget: '2000.00',
      actorUserId: 'ana',
    })
    const externo = await caso.ejecutar(EVENTO, {
      externalName: 'DJ Max',
      category: 'Music',
      actorUserId: 'ana',
    })

    expect(vinculado).toMatchObject({ name: 'Lumière', assignedBudget: '2000.00' })
    expect(externo).toMatchObject({ name: 'DJ Max', assignedBudget: null })
  })
```

Donde `PERFIL = '33333333-3333-4333-8333-333333333333'`. Cambiar en todos los tests del módulo los `assignedBudget: 1500` por `'1500.00'`.

- [ ] **Step 2: Ejecutar**

Run: `npx vitest run src/modules/vendors`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Puerto (`event-vendor.repository.ts`):
- `assignedBudget: string | null` en `EventVendorVista`, `DatosCrearEventVendor` y `CambiosEventVendor` (este último, `string | null | undefined`).
- `name: string` en `EventVendorVista`.
- Método nuevo:

```ts
  /** ¿Tiene gastos? Borrarlo los dejaría huérfanos: la FK es `Restrict`. */
  tieneGastos(eventId: string, eventVendorId: string): Promise<boolean>
```

`vendor-errors.ts`:

```ts
import { ConflictError, NotFoundError } from '@/shared/domain'

/** Con gastos no se borra: se marca CANCELLED y el histórico de pagos queda. */
export class ProveedorConGastosError extends ConflictError {
  constructor() {
    super(
      'El proveedor tiene gastos registrados; márcalo como CANCELLED en lugar de eliminarlo',
      'VENDOR_HAS_EXPENSES',
    )
  }
}
```

`remove-event-vendor.use-case.ts`, después del 404:

```ts
    if (await this.vendors.tieneGastos(eventId, eventVendorId)) throw new ProveedorConGastosError()
```

`add-event-vendor.use-case.ts`: `assignedBudget?: string | undefined` en `CrearEventVendor`.

DTO (`event-vendor.dto.ts`): `assignedBudget: montoSchema.optional()` en create y `montoSchema.nullable().optional()` en update, con import de `@/shared/http/esquemas`. Se admite 0: el esquema viejo era `positive()`, pero el presupuesto asignado puede ser 0.

Prisma (`prisma-event-vendor.repository.ts`):
- Todas las lecturas y escrituras que devuelven fila usan `include: { vendorProfile: { select: { businessName: true } } }`. En `crear` se añade al `create`; en `actualizar`, al `findFirst`; y en `listarPorEvento` y `buscarPorId`, al `findMany`/`findFirst`.
- `aVista(fila: EventVendorFila & { vendorProfile: { businessName: string } | null })`:
  - `assignedBudget: fila.assignedBudget === null ? null : fila.assignedBudget.toFixed(2)`
  - `name: fila.vendorProfile?.businessName ?? fila.externalName ?? ''`
- Método nuevo:

```ts
  async tieneGastos(eventId: string, eventVendorId: string): Promise<boolean> {
    const n = await this.prisma.expense.count({ where: { eventId, eventVendorId } })
    return n > 0
  }
```

Doble (`event-vendor.repository.fake.ts`):
- `FilaEnMemoria.assignedBudget: string | null`.
- `readonly gastos: Array<{ eventId: string; eventVendorId: string }> = []`.
- `PerfilPublicadoEnMemoria.businessName?: string`.
- `aVista` calcula `name`: si el ref es `linked`, busca en `perfiles` y usa su `businessName ?? ''`; si es externo, usa `vendorRef.name`.
- `tieneGastos` → `this.gastos.some((g) => g.eventId === eventId && g.eventVendorId === eventVendorId)`.

Controlador: `EventVendorRespuesta` añade `name: string` y `assignedBudget: string | null`, y `aRespuesta` los copia.

En `test/e2e/event-vendors.e2e.test.ts`, las aserciones que comparan `assignedBudget` como número pasan a string (`'1500.00'`).

- [ ] **Step 4: Ejecutar**

Run: `npm run typecheck && npx vitest run src/modules/vendors test/e2e/event-vendors.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/vendors test/e2e/event-vendors.e2e.test.ts
git commit -m "feat: proveedores con nombre visible, montos exactos y bloqueo de borrado con gastos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Catálogo de proveedores `GET /vendors`

**Files:**
- Create: `src/modules/vendors/application/vendor-catalog.repository.ts`
- Create: `src/modules/vendors/application/search-vendor-catalog.use-case.ts` y `.test.ts`
- Create: `src/modules/vendors/infrastructure/vendor-catalog.repository.fake.ts` y `prisma-vendor-catalog.repository.ts`
- Create: `src/modules/vendors/infrastructure/vendor-catalog.repository.paridad.test.ts`
- Create: `src/modules/vendors/interfaces/vendor-catalog.dto.ts` y `vendor-catalog.controller.ts`
- Modify: `src/modules/vendors/vendors.module.ts` y `src/shared/http/limitadores.ts`
- Create: `test/e2e/vendor-catalog.e2e.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PerfilDeCatalogo { id: string; businessName: string; category: string; specialty: string | null; createdAt: Date }
export interface BusquedaCatalogo { q: string | null; category: string | null; cursor: CursorValue | null; limit: number }
export interface VendorCatalogRepository { buscar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>> }
export const VENDOR_CATALOG_REPOSITORY = Symbol('VENDOR_CATALOG_REPOSITORY')
// SearchVendorCatalogUseCase.ejecutar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>>
// HTTP: GET /vendors?q=&category=&cursor=&limit= → { items: [{ id, businessName, category, specialty }], nextCursor: string | null }
```

- Orden `createdAt asc, id asc`. Solo perfiles `PUBLISHED`. `q` busca con `contains` sin mayúsculas en `businessName` o `specialty`. `category` es igual sin mayúsculas.
- El doble guarda `perfiles: Array<PerfilDeCatalogo & { status: 'DRAFT' | 'PUBLISHED' | 'SUSPENDED' }>`.

- [ ] **Step 1: Test de paridad que falla**

`vendor-catalog.repository.paridad.test.ts`, con la misma estructura que `event.repository.paridad.test.ts` de la Tarea 6. El sembrado es doble: se crea cada perfil con `prisma.user.create` + `prisma.vendorProfile.create` (con `createdAt` explícito) y se copia al doble con el mismo `id` y el mismo `createdAt`.

```ts
const BASE = new Date('2026-03-01T00:00:00.000Z')

  async function sembrar(n: number, datos: { businessName: string; category: string; specialty?: string; status?: 'DRAFT' | 'PUBLISHED' | 'SUSPENDED' }) {
    const user = await prisma.user.create({
      data: { email: `v${n}@catalogo.test`, passwordHash: 'x', fullName: `V${n}` },
    })
    const createdAt = new Date(BASE.getTime() + n * 60_000)
    const fila = await prisma.vendorProfile.create({
      data: {
        userId: user.id,
        businessName: datos.businessName,
        category: datos.category,
        specialty: datos.specialty ?? null,
        status: datos.status ?? 'PUBLISHED',
        createdAt,
      },
    })
    doble.perfiles.push({
      id: fila.id,
      businessName: datos.businessName,
      category: datos.category,
      specialty: datos.specialty ?? null,
      status: datos.status ?? 'PUBLISHED',
      createdAt,
    })
  }

  beforeAll(async () => {
    // ...pg, prisma, doble = new VendorCatalogRepositoryEnMemoria()...
    await sembrar(1, { businessName: 'Lumière Catering', category: 'Catering' })
    await sembrar(2, { businessName: 'Foto Luz', category: 'Photography', specialty: 'Bodas al aire libre' })
    await sembrar(3, { businessName: 'Oculto', category: 'Catering', status: 'DRAFT' })
    await sembrar(4, { businessName: 'Suspendido', category: 'Catering', status: 'SUSPENDED' })
    await sembrar(5, { businessName: 'Banquetes Sol', category: 'catering' })
  }, 120_000)

  it.each([
    [{ q: null, category: null }, ['Lumière Catering', 'Foto Luz', 'Banquetes Sol']],
    [{ q: 'LUZ', category: null }, ['Foto Luz']],
    [{ q: 'aire libre', category: null }, ['Foto Luz']],
    [{ q: null, category: 'CATERING' }, ['Lumière Catering', 'Banquetes Sol']],
  ])('buscar(%o)', async (filtro, esperado) => {
    for (const repo of [real, doble]) {
      const pagina = await repo.buscar({ ...filtro, cursor: null, limit: 20 })
      expect(pagina.items.map((p) => p.businessName)).toEqual(esperado)
      expect(pagina.nextCursor).toBeNull()
    }
  })

  it('pagina con cursor sin saltos ni repetidos', async () => {
    for (const repo of [real, doble]) {
      const p1 = await repo.buscar({ q: null, category: null, cursor: null, limit: 2 })
      expect(p1.items.map((p) => p.businessName)).toEqual(['Lumière Catering', 'Foto Luz'])
      expect(p1.nextCursor).not.toBeNull()
      const p2 = await repo.buscar({ q: null, category: null, cursor: decodeCursor(p1.nextCursor ?? ''), limit: 2 })
      expect(p2.items.map((p) => p.businessName)).toEqual(['Banquetes Sol'])
      expect(p2.nextCursor).toBeNull()
    }
  })
```

- [ ] **Step 2: Ejecutar**

Run: `npx vitest run src/modules/vendors/infrastructure/vendor-catalog.repository.paridad.test.ts`
Expected: FAIL (no existen los módulos).

- [ ] **Step 3: Implementar el puerto, el doble y Prisma**

`vendor-catalog.repository.ts`: el contenido de *Produces* más `import type { CursorPage, CursorValue } from '@/shared/domain'`.

`vendor-catalog.repository.fake.ts`:

```ts
import { encodeCursor, type CursorPage } from '@/shared/domain'

import type {
  BusquedaCatalogo,
  PerfilDeCatalogo,
  VendorCatalogRepository,
} from '../application/vendor-catalog.repository'

export class VendorCatalogRepositoryEnMemoria implements VendorCatalogRepository {
  readonly perfiles: Array<PerfilDeCatalogo & { status: 'DRAFT' | 'PUBLISHED' | 'SUSPENDED' }> = []

  buscar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>> {
    const q = busqueda.q?.toLowerCase() ?? null
    const categoria = busqueda.category?.toLowerCase() ?? null
    const { cursor } = busqueda
    const candidatos = this.perfiles
      .filter((p) => p.status === 'PUBLISHED')
      .filter((p) => categoria === null || p.category.toLowerCase() === categoria)
      .filter(
        (p) =>
          q === null ||
          p.businessName.toLowerCase().includes(q) ||
          (p.specialty?.toLowerCase().includes(q) ?? false),
      )
      .filter(
        (p) =>
          cursor === null ||
          p.createdAt.getTime() > cursor.createdAt.getTime() ||
          (p.createdAt.getTime() === cursor.createdAt.getTime() && p.id > cursor.id),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))

    const items = candidatos.slice(0, busqueda.limit).map(({ status: _s, ...perfil }) => perfil)
    const ultimo = items.at(-1)
    const nextCursor =
      candidatos.length > busqueda.limit && ultimo !== undefined
        ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id })
        : null
    return Promise.resolve({ items, nextCursor })
  }
}
```

`prisma-vendor-catalog.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { encodeCursor, type CursorPage } from '@/shared/domain'

import type {
  BusquedaCatalogo,
  PerfilDeCatalogo,
  VendorCatalogRepository,
} from '../application/vendor-catalog.repository'

@Injectable()
export class PrismaVendorCatalogRepository implements VendorCatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async buscar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>> {
    const { q, category, cursor, limit } = busqueda
    const where: Prisma.VendorProfileWhereInput = {
      status: 'PUBLISHED',
      ...(category !== null ? { category: { equals: category, mode: 'insensitive' } } : {}),
      ...(q !== null
        ? {
            OR: [
              { businessName: { contains: q, mode: 'insensitive' } },
              { specialty: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(cursor !== null
        ? {
            AND: [
              {
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                ],
              },
            ],
          }
        : {}),
    }
    // Uno de más para saber si hay página siguiente sin un COUNT aparte.
    const filas = await this.prisma.vendorProfile.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: { id: true, businessName: true, category: true, specialty: true, createdAt: true },
    })
    const items = filas.slice(0, limit)
    const ultimo = items.at(-1)
    return {
      items,
      nextCursor:
        filas.length > limit && ultimo !== undefined
          ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id })
          : null,
    }
  }
}
```

Hay un solapamiento: `q` usa `OR` y el cursor también usa `OR`. Por eso el cursor va dentro de `AND` y los dos no se pisan.

- [ ] **Step 4: Caso de uso, DTO, controlador y limitador**

`search-vendor-catalog.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'

import type { CursorPage } from '@/shared/domain'

import {
  type BusquedaCatalogo,
  type PerfilDeCatalogo,
  VENDOR_CATALOG_REPOSITORY,
  type VendorCatalogRepository,
} from './vendor-catalog.repository'

@Injectable()
export class SearchVendorCatalogUseCase {
  constructor(
    @Inject(VENDOR_CATALOG_REPOSITORY) private readonly catalogo: VendorCatalogRepository,
  ) {}

  /** Solo búsqueda: el marketplace completo (fichas, reseñas) queda fuera de alcance. */
  async ejecutar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>> {
    return await this.catalogo.buscar(busqueda)
  }
}
```

Test del caso de uso (`search-vendor-catalog.use-case.test.ts`): siembra 2 perfiles publicados y 1 en DRAFT en el doble, y comprueba que solo devuelve los 2 publicados.

`vendor-catalog.dto.ts`:

```ts
import { z } from 'zod'

const textoOpcional = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : v))

export const vendorCatalogQuerySchema = z.object({
  q: textoOpcional,
  category: textoOpcional,
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
```

`limitadores.ts`: añadir `export const LIMITADOR_VENDOR_CATALOG = 'vendor-catalog'` a la unión `LimitadorDeRuta` y a `crearLimitadores`:

```ts
    {
      name: LIMITADOR_VENDOR_CATALOG,
      ttl: 60_000,
      limit: 60,
      skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_VENDOR_CATALOG),
    },
```

Se cuenta por IP, que es el tracker por defecto. DESIGN-GAP: la spec pedía contar por usuario, pero `ThrottlerGuard` es `APP_GUARD` y corre antes que `JwtAuthGuard`, así que `req.user` aún no existe cuando el limitador cuenta. Hay que dejar este comentario en el código.

`vendor-catalog.controller.ts`:

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common'

import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { decodeCursor } from '@/shared/domain'
import { LIMITADOR_VENDOR_CATALOG, LimiteDeRuta } from '@/shared/http/limitadores'
import { validarCon } from '@/shared/http/validar-con'

import { SearchVendorCatalogUseCase } from '../application/search-vendor-catalog.use-case'
import { vendorCatalogQuerySchema } from './vendor-catalog.dto'

interface PerfilRespuesta {
  id: string
  businessName: string
  category: string
  specialty: string | null
}

/** Cualquier usuario con sesión puede buscar proveedores para su evento. */
@UseGuards(JwtAuthGuard)
@Controller('vendors')
export class VendorCatalogController {
  constructor(private readonly buscar: SearchVendorCatalogUseCase) {}

  @LimiteDeRuta(LIMITADOR_VENDOR_CATALOG, { limit: 60, ttl: 60_000 })
  @Get()
  async buscarVendors(
    @Query() query: unknown,
  ): Promise<{ items: PerfilRespuesta[]; nextCursor: string | null }> {
    const datos = validarCon(vendorCatalogQuerySchema, query)
    const pagina = await this.buscar.ejecutar({
      q: datos.q,
      category: datos.category,
      // Un cursor ilegible es InvalidCursorError → 400 (filtro global).
      cursor: datos.cursor === undefined ? null : decodeCursor(datos.cursor),
      limit: datos.limit,
    })
    return {
      items: pagina.items.map(({ id, businessName, category, specialty }) => ({
        id,
        businessName,
        category,
        specialty,
      })),
      nextCursor: pagina.nextCursor,
    }
  }
}
```

`vendors.module.ts`: añadir `VendorCatalogController` a `controllers`, y a `providers` el provider `VENDOR_CATALOG_REPOSITORY` (con `useFactory` sobre `PrismaService`, igual que `EVENT_VENDOR_REPOSITORY`) y `SearchVendorCatalogUseCase`.

- [ ] **Step 5: e2e**

`test/e2e/vendor-catalog.e2e.test.ts`, con el mismo arranque que `event-vendors.e2e.test.ts`:

```ts
  it('sin sesión → 401', async () => {
    await request(url).get('/vendors').expect(401)
  })

  it('lista solo perfiles PUBLISHED y filtra por q', async () => {
    // Sembrar con prisma: 1 PUBLISHED "Lumière" y 1 DRAFT "Oculto".
    const res = await request(url)
      .get('/vendors?q=lumi')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)
    expect(res.body).toEqual({
      items: [{ id: expect.any(String), businessName: 'Lumière', category: 'Catering', specialty: null }],
      nextCursor: null,
    })
  })

  it('cursor inválido → 400 y limit fuera de rango → 400', async () => {
    await request(url).get('/vendors?cursor=basura').set('Authorization', `Bearer ${ana.accessToken}`).expect(400)
    await request(url).get('/vendors?limit=500').set('Authorization', `Bearer ${ana.accessToken}`).expect(400)
  })
```

- [ ] **Step 6: Ejecutar**

Run: `npm run typecheck && npx vitest run src/modules/vendors test/e2e/vendor-catalog.e2e.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/vendors src/shared/http/limitadores.ts test/e2e/vendor-catalog.e2e.test.ts
git commit -m "feat: catálogo de proveedores publicados con búsqueda y cursor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Módulo `schedule` (cronograma con estado)

**Files:**
- Create: `src/modules/schedule/domain/schedule-item.ts` (+ `.test.ts`) y `src/modules/schedule/domain/schedule-errors.ts`
- Create: `src/modules/schedule/application/schedule-item.repository.ts`
- Create: `src/modules/schedule/application/list-schedule-items.use-case.ts`, `create-schedule-item.use-case.ts`, `update-schedule-item.use-case.ts` y `delete-schedule-item.use-case.ts`, con un test común `schedule-items.use-cases.test.ts`
- Create: `src/modules/schedule/infrastructure/schedule-item.repository.fake.ts`, `prisma-schedule-item.repository.ts` y `schedule-item.repository.paridad.test.ts`
- Create: `src/modules/schedule/interfaces/schedule.dto.ts` y `schedule.controller.ts`
- Create: `src/modules/schedule/schedule.module.ts`
- Modify: `src/app.module.ts`
- Create: `test/e2e/schedule.e2e.test.ts`

**Interfaces:**
- Produces:

```ts
// domain/schedule-item.ts
export type ScheduleItemStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE'
export interface ScheduleItem {
  id: string; eventId: string; title: string; description: string | null
  startsAt: Date; endsAt: Date | null; location: Ubicacion | null
  status: ScheduleItemStatus; createdAt: Date; updatedAt: Date
}
export function rangoValido(startsAt: Date, endsAt: Date | null): boolean
// domain/schedule-errors.ts
export class ItemDeCronogramaNoEncontradoError extends NotFoundError // 'SCHEDULE_ITEM_NOT_FOUND'
export class RangoDeCronogramaInvalidoError extends UnprocessableError // 'INVALID_SCHEDULE_RANGE'
// application/schedule-item.repository.ts
export interface DatosNuevoItem { eventId: string; title: string; description: string | null; startsAt: Date; endsAt: Date | null; location: Ubicacion | null; status: ScheduleItemStatus }
export interface CambiosItem { title?: string | undefined; description?: string | null | undefined; startsAt?: Date | undefined; endsAt?: Date | null | undefined; location?: Ubicacion | null | undefined; status?: ScheduleItemStatus | undefined }
export interface ScheduleItemRepository {
  listarPorEvento(eventId: string): Promise<ScheduleItem[]> // startsAt asc, id asc
  buscarPorId(eventId: string, itemId: string): Promise<ScheduleItem | null>
  crear(datos: DatosNuevoItem): Promise<ScheduleItem>
  actualizar(eventId: string, itemId: string, cambios: CambiosItem): Promise<ScheduleItem> // 404 si no existe
  eliminar(eventId: string, itemId: string): Promise<boolean> // false si no existía
}
export const SCHEDULE_ITEM_REPOSITORY = Symbol('SCHEDULE_ITEM_REPOSITORY')
// HTTP (bajo events/:eventId/schedule): GET → ItemRespuesta[]; POST → 201 ItemRespuesta; PATCH /:itemId → ItemRespuesta; DELETE /:itemId → 204
// ItemRespuesta = { id, eventId, title, description, startsAt: string, endsAt: string | null, location: Ubicacion | null, status }
```

- [ ] **Step 1: Tests de dominio y de casos de uso que fallan**

`schedule-item.test.ts`:

```ts
import { rangoValido } from './schedule-item'

describe('rangoValido', () => {
  const a = new Date('2027-06-12T20:00:00Z')
  it('sin fin es válido', () => expect(rangoValido(a, null)).toBe(true))
  it('fin igual al inicio es válido', () => expect(rangoValido(a, a)).toBe(true))
  it('fin antes del inicio no es válido', () =>
    expect(rangoValido(a, new Date('2027-06-12T19:59:59Z'))).toBe(false))
})
```

`schedule-items.use-cases.test.ts`:

```ts
import { ItemDeCronogramaNoEncontradoError, RangoDeCronogramaInvalidoError } from '../domain/schedule-errors'
import { ScheduleItemRepositoryEnMemoria } from '../infrastructure/schedule-item.repository.fake'
import { CreateScheduleItemUseCase } from './create-schedule-item.use-case'
import { DeleteScheduleItemUseCase } from './delete-schedule-item.use-case'
import { ListScheduleItemsUseCase } from './list-schedule-items.use-case'
import { UpdateScheduleItemUseCase } from './update-schedule-item.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const OTRO = '22222222-2222-4222-8222-222222222222'
const base = {
  title: 'Inicio de la fiesta',
  description: null,
  startsAt: new Date('2027-06-12T22:00:00Z'),
  endsAt: null,
  location: null,
}

describe('casos de uso del cronograma', () => {
  it('crea en PENDING por defecto y lista ordenado por hora', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const crear = new CreateScheduleItemUseCase(repo)
    await crear.ejecutar(EVENTO, { ...base, title: 'Fiesta' })
    await crear.ejecutar(EVENTO, { ...base, title: 'Ceremonia', startsAt: new Date('2027-06-12T18:00:00Z') })

    const lista = await new ListScheduleItemsUseCase(repo).ejecutar(EVENTO)

    expect(lista.map((i) => [i.title, i.status])).toEqual([
      ['Ceremonia', 'PENDING'],
      ['Fiesta', 'PENDING'],
    ])
  })

  it('PATCH que deja el fin antes del inicio guardado → 422', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const item = await new CreateScheduleItemUseCase(repo).ejecutar(EVENTO, base)

    await expect(
      new UpdateScheduleItemUseCase(repo).ejecutar(EVENTO, item.id, {
        endsAt: new Date('2027-06-12T21:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(RangoDeCronogramaInvalidoError)
  })

  it('cambia el estado hasta DONE', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const item = await new CreateScheduleItemUseCase(repo).ejecutar(EVENTO, base)

    const hecho = await new UpdateScheduleItemUseCase(repo).ejecutar(EVENTO, item.id, { status: 'DONE' })

    expect(hecho.status).toBe('DONE')
  })

  it('un ítem de otro evento es 404 al editar y al borrar', async () => {
    const repo = new ScheduleItemRepositoryEnMemoria()
    const item = await new CreateScheduleItemUseCase(repo).ejecutar(OTRO, base)

    await expect(
      new UpdateScheduleItemUseCase(repo).ejecutar(EVENTO, item.id, { title: 'X' }),
    ).rejects.toBeInstanceOf(ItemDeCronogramaNoEncontradoError)
    await expect(new DeleteScheduleItemUseCase(repo).ejecutar(EVENTO, item.id)).rejects.toBeInstanceOf(
      ItemDeCronogramaNoEncontradoError,
    )
  })
})
```

- [ ] **Step 2: Ejecutar**

Run: `npx vitest run src/modules/schedule`
Expected: FAIL (el módulo no existe).

- [ ] **Step 3: Implementar el dominio, el puerto y los casos de uso**

`domain/schedule-item.ts`:

```ts
import type { Ubicacion } from '@/shared/domain'

export type ScheduleItemStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE'

/**
 * Un momento del día del evento ("Inicio de la fiesta"). `location` null =
 * mismo lugar que el evento; el cliente decide cómo pintarlo. Los instantes
 * son UTC; el frontend los muestra en la `timezone` del evento.
 */
export interface ScheduleItem {
  id: string
  eventId: string
  title: string
  description: string | null
  startsAt: Date
  endsAt: Date | null
  location: Ubicacion | null
  status: ScheduleItemStatus
  createdAt: Date
  updatedAt: Date
}

export function rangoValido(startsAt: Date, endsAt: Date | null): boolean {
  return endsAt === null || endsAt.getTime() >= startsAt.getTime()
}
```

`domain/schedule-errors.ts`:

```ts
import { NotFoundError, UnprocessableError } from '@/shared/domain'

/** No existe o es de otro evento: mismo 404 (no se revela si el id existe). */
export class ItemDeCronogramaNoEncontradoError extends NotFoundError {
  constructor() {
    super('El ítem del cronograma no existe en este evento', 'SCHEDULE_ITEM_NOT_FOUND')
  }
}

export class RangoDeCronogramaInvalidoError extends UnprocessableError {
  constructor() {
    super('La hora de fin no puede ser anterior a la de inicio', 'INVALID_SCHEDULE_RANGE')
  }
}
```

`application/schedule-item.repository.ts`: el contenido de *Produces*.

`application/create-schedule-item.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'

import { rangoValido, type ScheduleItem } from '../domain/schedule-item'
import { RangoDeCronogramaInvalidoError } from '../domain/schedule-errors'
import {
  type DatosNuevoItem,
  SCHEDULE_ITEM_REPOSITORY,
  type ScheduleItemRepository,
} from './schedule-item.repository'

export type EntradaNuevoItem = Omit<DatosNuevoItem, 'eventId' | 'status'> & {
  status?: DatosNuevoItem['status'] | undefined
}

@Injectable()
export class CreateScheduleItemUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  async ejecutar(eventId: string, entrada: EntradaNuevoItem): Promise<ScheduleItem> {
    if (!rangoValido(entrada.startsAt, entrada.endsAt)) throw new RangoDeCronogramaInvalidoError()
    return await this.items.crear({ ...entrada, eventId, status: entrada.status ?? 'PENDING' })
  }
}
```

`application/update-schedule-item.use-case.ts`:

```ts
@Injectable()
export class UpdateScheduleItemUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  /** El rango se valida contra lo guardado: un PATCH puede traer solo el fin. */
  async ejecutar(eventId: string, itemId: string, cambios: CambiosItem): Promise<ScheduleItem> {
    const actual = await this.items.buscarPorId(eventId, itemId)
    if (actual === null) throw new ItemDeCronogramaNoEncontradoError()
    const startsAt = cambios.startsAt ?? actual.startsAt
    const endsAt = cambios.endsAt !== undefined ? cambios.endsAt : actual.endsAt
    if (!rangoValido(startsAt, endsAt)) throw new RangoDeCronogramaInvalidoError()
    return await this.items.actualizar(eventId, itemId, cambios)
  }
}
```

Con los imports correspondientes, igual que en `create`.

`application/list-schedule-items.use-case.ts`: `ejecutar(eventId)` → `this.items.listarPorEvento(eventId)`.

`application/delete-schedule-item.use-case.ts`: `ejecutar(eventId, itemId)` → `if (!(await this.items.eliminar(eventId, itemId))) throw new ItemDeCronogramaNoEncontradoError()`.

- [ ] **Step 4: Doble y adaptador Prisma**

`infrastructure/schedule-item.repository.fake.ts`:

```ts
import { randomUUID } from 'node:crypto'

import type {
  CambiosItem,
  DatosNuevoItem,
  ScheduleItemRepository,
} from '../application/schedule-item.repository'
import type { ScheduleItem } from '../domain/schedule-item'
import { ItemDeCronogramaNoEncontradoError } from '../domain/schedule-errors'

export class ScheduleItemRepositoryEnMemoria implements ScheduleItemRepository {
  readonly items: ScheduleItem[] = []

  listarPorEvento(eventId: string): Promise<ScheduleItem[]> {
    return Promise.resolve(
      this.items
        .filter((i) => i.eventId === eventId)
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.id < b.id ? -1 : 1))
        .map((i) => ({ ...i })),
    )
  }

  buscarPorId(eventId: string, itemId: string): Promise<ScheduleItem | null> {
    const item = this.items.find((i) => i.id === itemId && i.eventId === eventId)
    return Promise.resolve(item === undefined ? null : { ...item })
  }

  crear(datos: DatosNuevoItem): Promise<ScheduleItem> {
    const ahora = new Date()
    const item: ScheduleItem = { ...datos, id: randomUUID(), createdAt: ahora, updatedAt: ahora }
    this.items.push(item)
    return Promise.resolve({ ...item })
  }

  actualizar(eventId: string, itemId: string, cambios: CambiosItem): Promise<ScheduleItem> {
    const item = this.items.find((i) => i.id === itemId && i.eventId === eventId)
    if (item === undefined) return Promise.reject(new ItemDeCronogramaNoEncontradoError())
    for (const clave of Object.keys(cambios) as Array<keyof CambiosItem>) {
      const valor = cambios[clave]
      if (valor !== undefined) Object.assign(item, { [clave]: valor })
    }
    item.updatedAt = new Date()
    return Promise.resolve({ ...item })
  }

  eliminar(eventId: string, itemId: string): Promise<boolean> {
    const indice = this.items.findIndex((i) => i.id === itemId && i.eventId === eventId)
    if (indice === -1) return Promise.resolve(false)
    this.items.splice(indice, 1)
    return Promise.resolve(true)
  }
}
```

`infrastructure/prisma-schedule-item.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'
import type { Prisma, ScheduleItem as Fila } from '@prisma/client'

import { clienteDe } from '@/modules/database/transaccion'
import { PrismaService } from '@/modules/database/prisma.service'
import type { Ubicacion } from '@/shared/domain'

import type {
  CambiosItem,
  DatosNuevoItem,
  ScheduleItemRepository,
} from '../application/schedule-item.repository'
import type { ScheduleItem } from '../domain/schedule-item'
import { ItemDeCronogramaNoEncontradoError } from '../domain/schedule-errors'

function columnasLugar(location: Ubicacion | null | undefined): Prisma.ScheduleItemUpdateManyMutationInput {
  if (location === undefined) return {}
  if (location === null) {
    return {
      locationName: null,
      locationAddress: null,
      locationLat: null,
      locationLng: null,
      locationMapboxId: null,
    }
  }
  return {
    locationName: location.name,
    locationAddress: location.address,
    locationLat: location.lat,
    locationLng: location.lng,
    locationMapboxId: location.mapboxId,
  }
}

@Injectable()
export class PrismaScheduleItemRepository implements ScheduleItemRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listarPorEvento(eventId: string): Promise<ScheduleItem[]> {
    const filas = await this.prisma.scheduleItem.findMany({
      where: { eventId },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    })
    return filas.map(aDominio)
  }

  async buscarPorId(eventId: string, itemId: string): Promise<ScheduleItem | null> {
    const fila = await this.prisma.scheduleItem.findFirst({ where: { id: itemId, eventId } })
    return fila === null ? null : aDominio(fila)
  }

  async crear(datos: DatosNuevoItem): Promise<ScheduleItem> {
    const fila = await clienteDe(this.prisma).scheduleItem.create({
      data: {
        eventId: datos.eventId,
        title: datos.title,
        description: datos.description,
        startsAt: datos.startsAt,
        endsAt: datos.endsAt,
        status: datos.status,
        ...(columnasLugar(datos.location) as Prisma.ScheduleItemUncheckedCreateInput),
      },
    })
    return aDominio(fila)
  }

  async actualizar(eventId: string, itemId: string, cambios: CambiosItem): Promise<ScheduleItem> {
    const cliente = clienteDe(this.prisma)
    const { count } = await cliente.scheduleItem.updateMany({
      where: { id: itemId, eventId },
      data: {
        ...(cambios.title !== undefined ? { title: cambios.title } : {}),
        ...(cambios.description !== undefined ? { description: cambios.description } : {}),
        ...(cambios.startsAt !== undefined ? { startsAt: cambios.startsAt } : {}),
        ...(cambios.endsAt !== undefined ? { endsAt: cambios.endsAt } : {}),
        ...(cambios.status !== undefined ? { status: cambios.status } : {}),
        ...columnasLugar(cambios.location),
      },
    })
    if (count === 0) throw new ItemDeCronogramaNoEncontradoError()
    const fila = await cliente.scheduleItem.findFirst({ where: { id: itemId, eventId } })
    if (fila === null) throw new ItemDeCronogramaNoEncontradoError()
    return aDominio(fila)
  }

  async eliminar(eventId: string, itemId: string): Promise<boolean> {
    const { count } = await clienteDe(this.prisma).scheduleItem.deleteMany({
      where: { id: itemId, eventId },
    })
    return count > 0
  }
}

function aDominio(fila: Fila): ScheduleItem {
  const tieneLugar =
    fila.locationAddress !== null && fila.locationLat !== null && fila.locationLng !== null
  return {
    id: fila.id,
    eventId: fila.eventId,
    title: fila.title,
    description: fila.description,
    startsAt: fila.startsAt,
    endsAt: fila.endsAt,
    location: tieneLugar
      ? {
          name: fila.locationName,
          address: fila.locationAddress ?? '',
          lat: Number(fila.locationLat),
          lng: Number(fila.locationLng),
          mapboxId: fila.locationMapboxId,
        }
      : null,
    status: fila.status,
    createdAt: fila.createdAt,
    updatedAt: fila.updatedAt,
  }
}
```

`infrastructure/schedule-item.repository.paridad.test.ts` sigue el patrón de la Tarea 6. Crea un usuario y dos eventos con `prisma.event.create`, y ejecuta contra los dos sujetos:
- crear con y sin `location` y comparar sin `id`/`createdAt`/`updatedAt`;
- listar el orden con tres ítems;
- `actualizar` con `location: null` y `status: 'IN_PROGRESS'`;
- `actualizar` sobre otro evento → `ItemDeCronogramaNoEncontradoError`;
- `eliminar` → `true` y luego `false`.

Para comparar los listados entre sujetos se comparan `title`, `startsAt`, `status` y `location`.

- [ ] **Step 5: DTO, controlador y módulo**

`interfaces/schedule.dto.ts`:

```ts
import { z } from 'zod'

import { ubicacionSchema } from '@/shared/http/esquemas'

const instante = z.iso.datetime({ offset: true }).transform((v) => new Date(v))
const estado = z.enum(['PENDING', 'IN_PROGRESS', 'DONE'])

export const createScheduleItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    startsAt: instante,
    endsAt: instante.nullable().optional(),
    location: ubicacionSchema.nullable().optional(),
    status: estado.optional(),
  })
  .strict()
  .refine((d) => d.endsAt == null || d.endsAt.getTime() >= d.startsAt.getTime(), {
    message: 'La hora de fin no puede ser anterior a la de inicio',
    path: ['endsAt'],
  })

export const updateScheduleItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    startsAt: instante.optional(),
    endsAt: instante.nullable().optional(),
    location: ubicacionSchema.nullable().optional(),
    status: estado.optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Indica al menos un cambio' })
```

`interfaces/schedule.controller.ts`:

```ts
@UseGuards(JwtAuthGuard, EventAccessGuard)
@Controller('events/:eventId/schedule')
export class ScheduleController {
  constructor(
    private readonly listar: ListScheduleItemsUseCase,
    private readonly crear: CreateScheduleItemUseCase,
    private readonly actualizar: UpdateScheduleItemUseCase,
    private readonly eliminar: DeleteScheduleItemUseCase,
  ) {}

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get()
  async listarItems(@Param('eventId') eventId: string): Promise<ItemRespuesta[]> {
    return (await this.listar.ejecutar(eventId)).map(aRespuesta)
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post()
  async crearItem(@Param('eventId') eventId: string, @Body() body: unknown): Promise<ItemRespuesta> {
    const datos = validarCon(createScheduleItemSchema, body)
    return aRespuesta(
      await this.crear.ejecutar(eventId, {
        title: datos.title,
        description: datos.description ?? null,
        startsAt: datos.startsAt,
        endsAt: datos.endsAt ?? null,
        location: datos.location ?? null,
        status: datos.status,
      }),
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Patch(':itemId')
  async editarItem(
    @Param('eventId') eventId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ): Promise<ItemRespuesta> {
    const id = idDeRuta(itemId, () => new ItemDeCronogramaNoEncontradoError())
    return aRespuesta(await this.actualizar.ejecutar(eventId, id, validarCon(updateScheduleItemSchema, body)))
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Delete(':itemId')
  @HttpCode(204)
  async borrarItem(@Param('eventId') eventId: string, @Param('itemId') itemId: string): Promise<void> {
    await this.eliminar.ejecutar(eventId, idDeRuta(itemId, () => new ItemDeCronogramaNoEncontradoError()))
  }
}

interface ItemRespuesta {
  id: string
  eventId: string
  title: string
  description: string | null
  startsAt: string
  endsAt: string | null
  location: Ubicacion | null
  status: ScheduleItemStatus
}

function aRespuesta(item: ScheduleItem): ItemRespuesta {
  return {
    id: item.id,
    eventId: item.eventId,
    title: item.title,
    description: item.description,
    startsAt: item.startsAt.toISOString(),
    endsAt: item.endsAt?.toISOString() ?? null,
    location: item.location,
    status: item.status,
  }
}
```

Los imports son los mismos que en `event-vendors.controller.ts` más `Delete`, `HttpCode` y `Patch`.

`schedule.module.ts`: `imports: [AuthModule, UsersModule, EventsModule]`, con el provider `SCHEDULE_ITEM_REPOSITORY` por `useFactory` sobre `PrismaService`, los 4 casos de uso y `controllers: [ScheduleController]`. Registrar `ScheduleModule` en `src/app.module.ts`, junto a `VendorsModule`.

- [ ] **Step 6: e2e**

`test/e2e/schedule.e2e.test.ts`, con el mismo arranque que `event-vendors.e2e.test.ts` y `crearEventoPublicado`:

```ts
  it('CRUD del cronograma con estado', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    const creado = await request(url)
      .post(`/events/${evento}/schedule`)
      .set(auth)
      .send({
        title: 'Inicio de la fiesta',
        startsAt: '2027-06-12T22:00:00-05:00',
        location: { name: 'Salón', address: 'Cra 7 #1', lat: 4.6, lng: -74.07 },
      })
      .expect(201)
    const id = (creado.body as { id: string }).id
    expect(creado.body).toMatchObject({ status: 'PENDING', startsAt: '2027-06-13T03:00:00.000Z' })

    await request(url).patch(`/events/${evento}/schedule/${id}`).set(auth).send({ status: 'DONE' }).expect(200)
    await request(url)
      .patch(`/events/${evento}/schedule/${id}`)
      .set(auth)
      .send({ endsAt: '2027-06-12T20:00:00-05:00' })
      .expect(422)

    const lista = await request(url).get(`/events/${evento}/schedule`).set(auth).expect(200)
    expect(lista.body).toHaveLength(1)

    await request(url).delete(`/events/${evento}/schedule/${id}`).set(auth).expect(204)
    await request(url).delete(`/events/${evento}/schedule/${id}`).set(auth).expect(404)
  })

  it('POST con fin antes de inicio → 400; id no UUID → 404; extraño → 404', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    await request(url)
      .post(`/events/${evento}/schedule`)
      .set(auth)
      .send({ title: 'X', startsAt: '2027-06-12T22:00:00Z', endsAt: '2027-06-12T21:00:00Z' })
      .expect(400)
    await request(url).patch(`/events/${evento}/schedule/no-uuid`).set(auth).send({ title: 'X' }).expect(404)
    await request(url)
      .get(`/events/${evento}/schedule`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)
  })
```

- [ ] **Step 7: Ejecutar**

Run: `npm run typecheck && npm run lint && npx vitest run src/modules/schedule test/e2e/schedule.e2e.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/schedule src/app.module.ts test/e2e/schedule.e2e.test.ts
git commit -m "feat: cronograma del evento con lugar propio y estado

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Módulo `expenses`: dominio, repositorio y casos de uso

**Files:**
- Create: `src/modules/expenses/domain/expense.ts` (+ `.test.ts`) y `src/modules/expenses/domain/expense-errors.ts`
- Create: `src/modules/expenses/application/expense.repository.ts`
- Create: `src/modules/expenses/application/create-expense.use-case.ts`, `update-expense.use-case.ts`, `delete-expense.use-case.ts`, `list-expenses.use-case.ts` y `budget-summary.use-case.ts`, con el test `expenses.use-cases.test.ts`
- Create: `src/modules/expenses/infrastructure/expense.repository.fake.ts`, `prisma-expense.repository.ts` y `expense.repository.paridad.test.ts`

**Interfaces:**
- Consumes:
  - `aCentimos`/`deCentimos`, `CursorPage` y `CursorValue` de `@/shared/domain`.
  - `EVENT_REPOSITORY` y `EventRepository` de `@/modules/events/application/event.repository`. Es el puerto de application, lo que está permitido.
  - `EventRepositoryEnMemoria` en los tests (fake, permitido).
- Produces:

```ts
// domain/expense.ts
export type ExpenseStatus = 'PENDING' | 'PAID'
export type OrigenGasto =
  | { kind: 'vendor'; eventVendorId: string; vendorName: string }
  | { kind: 'external'; payeeName: string }
export interface Expense {
  id: string; eventId: string; origen: OrigenGasto; concept: string; category: string
  amount: string; status: ExpenseStatus; dueDate: Date | null; paidAt: Date | null
  notes: string | null; createdById: string; createdAt: Date; updatedAt: Date
}
export interface ResumenPresupuesto {
  currency: string; totalBudget: string | null; assigned: string; unassigned: string | null
  paid: string; pending: string; remaining: string | null
}
export function calcularResumen(e: { currency: string; totalBudget: string | null; assigned: string; paid: string; pending: string }): ResumenPresupuesto
export function paidAtTrasCambio(actual: { status: ExpenseStatus; paidAt: Date | null }, nuevoEstado: ExpenseStatus | undefined, ahora: Date): Date | null
// domain/expense-errors.ts
export class GastoNoEncontradoError extends NotFoundError // 'EXPENSE_NOT_FOUND'
export class ProveedorDelEventoNoEncontradoError extends NotFoundError // 'EVENT_VENDOR_NOT_FOUND'
// application/expense.repository.ts
export type OrigenEntrada = { kind: 'vendor'; eventVendorId: string } | { kind: 'external'; payeeName: string }
export interface DatosNuevoGasto { eventId: string; origen: OrigenEntrada; concept: string; category: string; amount: string; status: ExpenseStatus; paidAt: Date | null; dueDate: Date | null; notes: string | null; createdById: string }
export interface CambiosGasto { origen?: OrigenEntrada | undefined; concept?: string | undefined; category?: string | undefined; amount?: string | undefined; status?: ExpenseStatus | undefined; paidAt?: Date | null | undefined; dueDate?: Date | null | undefined; notes?: string | null | undefined }
export interface FiltroGastos { status: ExpenseStatus | null; origin: 'vendor' | 'external' | null; eventVendorId: string | null }
export interface SumasPresupuesto { assigned: string; paid: string; pending: string }
export interface ExpenseRepository {
  proveedorExiste(eventId: string, eventVendorId: string): Promise<boolean>
  crear(datos: DatosNuevoGasto): Promise<Expense>
  buscarPorId(eventId: string, expenseId: string): Promise<Expense | null>
  listar(eventId: string, filtro: FiltroGastos, cursor: CursorValue | null, limit: number): Promise<CursorPage<Expense>> // createdAt desc, id desc
  actualizar(eventId: string, expenseId: string, cambios: CambiosGasto): Promise<Expense> // 404 si no existe
  eliminar(eventId: string, expenseId: string): Promise<boolean>
  sumas(eventId: string): Promise<SumasPresupuesto>
}
export const EXPENSE_REPOSITORY = Symbol('EXPENSE_REPOSITORY')
// casos de uso
CreateExpenseUseCase.ejecutar(eventId: string, entrada: EntradaGasto, actorId: string): Promise<Expense>
UpdateExpenseUseCase.ejecutar(eventId: string, expenseId: string, cambios: Omit<CambiosGasto, 'paidAt'>): Promise<Expense>
DeleteExpenseUseCase.ejecutar(eventId: string, expenseId: string): Promise<void>
ListExpensesUseCase.ejecutar(eventId: string, filtro: FiltroGastos, cursor: CursorValue | null, limit: number): Promise<CursorPage<Expense>>
BudgetSummaryUseCase.ejecutar(eventId: string): Promise<ResumenPresupuesto>
// EntradaGasto = Omit<DatosNuevoGasto, 'eventId' | 'createdById' | 'paidAt' | 'status'> & { status?: ExpenseStatus | undefined }
```

- [ ] **Step 1: Tests de dominio que fallan**

`domain/expense.test.ts`:

```ts
import { calcularResumen, paidAtTrasCambio } from './expense'

describe('calcularResumen', () => {
  it('con total calcula sin asignar y lo que queda, admitiendo negativos', () => {
    expect(
      calcularResumen({ currency: 'USD', totalBudget: '1000.00', assigned: '1200.00', paid: '300.10', pending: '800.00' }),
    ).toEqual({
      currency: 'USD',
      totalBudget: '1000.00',
      assigned: '1200.00',
      unassigned: '-200.00',
      paid: '300.10',
      pending: '800.00',
      remaining: '-100.10',
    })
  })

  it('sin total, sin asignar y lo que queda son null', () => {
    expect(
      calcularResumen({ currency: 'EUR', totalBudget: null, assigned: '0.00', paid: '0.00', pending: '0.00' }),
    ).toMatchObject({ unassigned: null, remaining: null })
  })
})

describe('paidAtTrasCambio', () => {
  const ahora = new Date('2027-01-01T00:00:00Z')
  const antes = new Date('2026-12-01T00:00:00Z')
  it('PENDING → PAID fija ahora', () =>
    expect(paidAtTrasCambio({ status: 'PENDING', paidAt: null }, 'PAID', ahora)).toEqual(ahora))
  it('PAID → PAID conserva la fecha original', () =>
    expect(paidAtTrasCambio({ status: 'PAID', paidAt: antes }, 'PAID', ahora)).toEqual(antes))
  it('PAID → PENDING la borra', () =>
    expect(paidAtTrasCambio({ status: 'PAID', paidAt: antes }, 'PENDING', ahora)).toBeNull())
  it('sin cambio de estado conserva', () =>
    expect(paidAtTrasCambio({ status: 'PAID', paidAt: antes }, undefined, ahora)).toEqual(antes))
})
```

- [ ] **Step 2: Tests de casos de uso que fallan**

`application/expenses.use-cases.test.ts`:

```ts
import { EventRepositoryEnMemoria } from '@/modules/events/infrastructure/event.repository.fake'

import { GastoNoEncontradoError, ProveedorDelEventoNoEncontradoError } from '../domain/expense-errors'
import { ExpenseRepositoryEnMemoria } from '../infrastructure/expense.repository.fake'
import { BudgetSummaryUseCase } from './budget-summary.use-case'
import { CreateExpenseUseCase } from './create-expense.use-case'
import { UpdateExpenseUseCase } from './update-expense.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const OTRO = '22222222-2222-4222-8222-222222222222'
const VENDOR = '33333333-3333-4333-8333-333333333333'

function montar() {
  const gastos = new ExpenseRepositoryEnMemoria()
  gastos.proveedores.push({
    id: VENDOR,
    eventId: EVENTO,
    name: 'DJ Max',
    assignedBudget: '500.00',
    status: 'BOOKED',
  })
  return { gastos, crear: new CreateExpenseUseCase(gastos), editar: new UpdateExpenseUseCase(gastos) }
}

const base = { concept: 'Anticipo', category: 'Music', amount: '200.00', dueDate: null, notes: null }

describe('casos de uso de gastos', () => {
  it('crea un gasto de proveedor con su nombre y uno externo', async () => {
    const { crear } = montar()
    const deVendor = await crear.ejecutar(EVENTO, { ...base, origen: { kind: 'vendor', eventVendorId: VENDOR } }, 'ana')
    const externo = await crear.ejecutar(EVENTO, { ...base, origen: { kind: 'external', payeeName: 'Imprenta' } }, 'ana')

    expect(deVendor.origen).toEqual({ kind: 'vendor', eventVendorId: VENDOR, vendorName: 'DJ Max' })
    expect(externo).toMatchObject({ origen: { kind: 'external', payeeName: 'Imprenta' }, status: 'PENDING', paidAt: null })
  })

  it('un proveedor de otro evento → 404 y no crea nada', async () => {
    const { gastos, crear } = montar()
    await expect(
      crear.ejecutar(OTRO, { ...base, origen: { kind: 'vendor', eventVendorId: VENDOR } }, 'ana'),
    ).rejects.toBeInstanceOf(ProveedorDelEventoNoEncontradoError)
    expect(gastos.gastos).toHaveLength(0)
  })

  it('crear ya pagado fija paidAt; marcar pagado y revertir lo gestiona', async () => {
    const { crear, editar } = montar()
    const pagado = await crear.ejecutar(EVENTO, { ...base, status: 'PAID', origen: { kind: 'external', payeeName: 'X' } }, 'ana')
    expect(pagado.paidAt).not.toBeNull()

    const revertido = await editar.ejecutar(EVENTO, pagado.id, { status: 'PENDING' })
    expect(revertido.paidAt).toBeNull()
  })

  it('editar un gasto de otro evento → 404', async () => {
    const { crear, editar } = montar()
    const gasto = await crear.ejecutar(EVENTO, { ...base, origen: { kind: 'external', payeeName: 'X' } }, 'ana')
    await expect(editar.ejecutar(OTRO, gasto.id, { concept: 'Y' })).rejects.toBeInstanceOf(GastoNoEncontradoError)
  })

  it('el resumen suma pagado, pendiente y asignado (sin CANCELLED)', async () => {
    const { gastos, crear } = montar()
    gastos.proveedores.push({ id: 'v2', eventId: EVENTO, name: 'Cancelado', assignedBudget: '999.00', status: 'CANCELLED' })
    await crear.ejecutar(EVENTO, { ...base, amount: '0.10', status: 'PAID', origen: { kind: 'external', payeeName: 'A' } }, 'ana')
    await crear.ejecutar(EVENTO, { ...base, amount: '0.20', status: 'PAID', origen: { kind: 'external', payeeName: 'B' } }, 'ana')
    await crear.ejecutar(EVENTO, { ...base, amount: '100.00', origen: { kind: 'vendor', eventVendorId: VENDOR } }, 'ana')

    const eventos = new EventRepositoryEnMemoria()
    eventos.eventos.push({ id: EVENTO, ownerId: 'ana', currency: 'COP', totalBudget: '1000.00' })

    expect(await new BudgetSummaryUseCase(gastos, eventos).ejecutar(EVENTO)).toEqual({
      currency: 'COP',
      totalBudget: '1000.00',
      assigned: '500.00',
      unassigned: '500.00',
      paid: '0.30',
      pending: '100.00',
      remaining: '899.70',
    })
  })
})
```

- [ ] **Step 3: Ejecutar**

Run: `npx vitest run src/modules/expenses`
Expected: FAIL (el módulo no existe).

- [ ] **Step 4: Implementar el dominio**

`domain/expense.ts`: los tipos de *Produces* más:

```ts
import { aCentimos, deCentimos } from '@/shared/domain'

export function calcularResumen(e: {
  currency: string
  totalBudget: string | null
  assigned: string
  paid: string
  pending: string
}): ResumenPresupuesto {
  const total = e.totalBudget === null ? null : aCentimos(e.totalBudget)
  return {
    currency: e.currency,
    totalBudget: e.totalBudget,
    assigned: e.assigned,
    // Puede ser negativo: asignar más de lo presupuestado es un dato, no un error.
    unassigned: total === null ? null : deCentimos(total - aCentimos(e.assigned)),
    paid: e.paid,
    pending: e.pending,
    remaining: total === null ? null : deCentimos(total - aCentimos(e.paid) - aCentimos(e.pending)),
  }
}

/**
 * `paidAt` lo decide el servidor, nunca el cliente: se fija al pasar a PAID,
 * se conserva mientras siga PAID y se borra al volver a PENDING. Así el CHECK
 * `expenses_pagado_con_fecha` no puede romperse desde la API.
 */
export function paidAtTrasCambio(
  actual: { status: ExpenseStatus; paidAt: Date | null },
  nuevoEstado: ExpenseStatus | undefined,
  ahora: Date,
): Date | null {
  const estado = nuevoEstado ?? actual.status
  if (estado === 'PENDING') return null
  return actual.status === 'PAID' && actual.paidAt !== null ? actual.paidAt : ahora
}
```

`domain/expense-errors.ts`:

```ts
import { NotFoundError } from '@/shared/domain'

export class GastoNoEncontradoError extends NotFoundError {
  constructor() {
    super('El gasto no existe en este evento', 'EXPENSE_NOT_FOUND')
  }
}

/** Mismo código que `EventVendorNoEncontradoError` de vendors: el cliente ve un único 404. */
export class ProveedorDelEventoNoEncontradoError extends NotFoundError {
  constructor() {
    super('El proveedor no existe en este evento', 'EVENT_VENDOR_NOT_FOUND')
  }
}
```

- [ ] **Step 5: Implementar el puerto y los casos de uso**

`application/expense.repository.ts`: el contenido de *Produces*, con `import type { CursorPage, CursorValue } from '@/shared/domain'`.

`application/create-expense.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'

import type { Expense, ExpenseStatus } from '../domain/expense'
import { ProveedorDelEventoNoEncontradoError } from '../domain/expense-errors'
import { type DatosNuevoGasto, EXPENSE_REPOSITORY, type ExpenseRepository } from './expense.repository'

export type EntradaGasto = Omit<DatosNuevoGasto, 'eventId' | 'createdById' | 'paidAt' | 'status'> & {
  status?: ExpenseStatus | undefined
}

@Injectable()
export class CreateExpenseUseCase {
  constructor(@Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository) {}

  async ejecutar(eventId: string, entrada: EntradaGasto, actorId: string): Promise<Expense> {
    if (
      entrada.origen.kind === 'vendor' &&
      !(await this.gastos.proveedorExiste(eventId, entrada.origen.eventVendorId))
    ) {
      throw new ProveedorDelEventoNoEncontradoError()
    }
    const status = entrada.status ?? 'PENDING'
    return await this.gastos.crear({
      ...entrada,
      eventId,
      status,
      paidAt: status === 'PAID' ? new Date() : null,
      createdById: actorId,
    })
  }
}
```

`application/update-expense.use-case.ts`:

```ts
@Injectable()
export class UpdateExpenseUseCase {
  constructor(@Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository) {}

  async ejecutar(
    eventId: string,
    expenseId: string,
    cambios: Omit<CambiosGasto, 'paidAt'>,
  ): Promise<Expense> {
    const actual = await this.gastos.buscarPorId(eventId, expenseId)
    if (actual === null) throw new GastoNoEncontradoError()
    if (
      cambios.origen?.kind === 'vendor' &&
      !(await this.gastos.proveedorExiste(eventId, cambios.origen.eventVendorId))
    ) {
      throw new ProveedorDelEventoNoEncontradoError()
    }
    return await this.gastos.actualizar(eventId, expenseId, {
      ...cambios,
      paidAt: paidAtTrasCambio(actual, cambios.status, new Date()),
    })
  }
}
```

`application/delete-expense.use-case.ts`: `if (!(await this.gastos.eliminar(eventId, expenseId))) throw new GastoNoEncontradoError()`.

`application/list-expenses.use-case.ts`: delega en `listar`.

`application/budget-summary.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'

import { EVENT_REPOSITORY, type EventRepository } from '@/modules/events/application/event.repository'
import { NotFoundError } from '@/shared/domain'

import { calcularResumen, type ResumenPresupuesto } from '../domain/expense'
import { EXPENSE_REPOSITORY, type ExpenseRepository } from './expense.repository'

@Injectable()
export class BudgetSummaryUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository,
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
  ) {}

  async ejecutar(eventId: string): Promise<ResumenPresupuesto> {
    const evento = await this.eventos.buscarPorId(eventId)
    // Solo lo alcanza un ADMIN sobre un id inexistente: el guard ya dio 404 al resto.
    if (evento === null) throw new NotFoundError('El evento no existe')
    const sumas = await this.gastos.sumas(eventId)
    return calcularResumen({ currency: evento.currency, totalBudget: evento.totalBudget, ...sumas })
  }
}
```

Se comprueba con `npm run lint:arch` que importar `@/modules/events/application/event.repository` desde `expenses/application` está permitido. Si dependency-cruiser lo rechaza, se crea en `expenses/application` un puerto `DatosDePresupuestoDelEvento` (`{ currency; totalBudget } | null`) con un adaptador en `expenses/infrastructure` que lee `prisma.event`, y el test usa un doble de ese puerto. Hay que anotar en el commit qué opción se tomó.

- [ ] **Step 6: Implementar el doble y Prisma**

`infrastructure/expense.repository.fake.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { aCentimos, deCentimos, encodeCursor, type CursorPage, type CursorValue } from '@/shared/domain'

import type {
  CambiosGasto,
  DatosNuevoGasto,
  ExpenseRepository,
  FiltroGastos,
  OrigenEntrada,
  SumasPresupuesto,
} from '../application/expense.repository'
import type { Expense, OrigenGasto } from '../domain/expense'
import { GastoNoEncontradoError } from '../domain/expense-errors'

export interface ProveedorEnMemoria {
  id: string
  eventId: string
  name: string
  assignedBudget: string | null
  status: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'
}

interface GastoEnMemoria extends Omit<Expense, 'origen'> {
  origen: OrigenEntrada
}

export class ExpenseRepositoryEnMemoria implements ExpenseRepository {
  readonly proveedores: ProveedorEnMemoria[] = []
  readonly gastos: GastoEnMemoria[] = []

  proveedorExiste(eventId: string, eventVendorId: string): Promise<boolean> {
    return Promise.resolve(this.proveedores.some((p) => p.id === eventVendorId && p.eventId === eventId))
  }

  crear(datos: DatosNuevoGasto): Promise<Expense> {
    const ahora = new Date()
    const gasto: GastoEnMemoria = { ...datos, id: randomUUID(), createdAt: ahora, updatedAt: ahora }
    this.gastos.push(gasto)
    return Promise.resolve(this.aDominio(gasto))
  }

  buscarPorId(eventId: string, expenseId: string): Promise<Expense | null> {
    const gasto = this.gastos.find((g) => g.id === expenseId && g.eventId === eventId)
    return Promise.resolve(gasto === undefined ? null : this.aDominio(gasto))
  }

  listar(eventId: string, filtro: FiltroGastos, cursor: CursorValue | null, limit: number): Promise<CursorPage<Expense>> {
    const candidatos = this.gastos
      .filter((g) => g.eventId === eventId)
      .filter((g) => filtro.status === null || g.status === filtro.status)
      .filter((g) => filtro.origin === null || g.origen.kind === filtro.origin)
      .filter(
        (g) =>
          filtro.eventVendorId === null ||
          (g.origen.kind === 'vendor' && g.origen.eventVendorId === filtro.eventVendorId),
      )
      .filter(
        (g) =>
          cursor === null ||
          g.createdAt.getTime() < cursor.createdAt.getTime() ||
          (g.createdAt.getTime() === cursor.createdAt.getTime() && g.id < cursor.id),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
    const items = candidatos.slice(0, limit)
    const ultimo = items.at(-1)
    return Promise.resolve({
      items: items.map((g) => this.aDominio(g)),
      nextCursor:
        candidatos.length > limit && ultimo !== undefined
          ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id })
          : null,
    })
  }

  actualizar(eventId: string, expenseId: string, cambios: CambiosGasto): Promise<Expense> {
    const gasto = this.gastos.find((g) => g.id === expenseId && g.eventId === eventId)
    if (gasto === undefined) return Promise.reject(new GastoNoEncontradoError())
    for (const clave of Object.keys(cambios) as Array<keyof CambiosGasto>) {
      const valor = cambios[clave]
      if (valor !== undefined) Object.assign(gasto, { [clave]: valor })
    }
    gasto.updatedAt = new Date()
    return Promise.resolve(this.aDominio(gasto))
  }

  eliminar(eventId: string, expenseId: string): Promise<boolean> {
    const i = this.gastos.findIndex((g) => g.id === expenseId && g.eventId === eventId)
    if (i === -1) return Promise.resolve(false)
    this.gastos.splice(i, 1)
    return Promise.resolve(true)
  }

  sumas(eventId: string): Promise<SumasPresupuesto> {
    const suma = (montos: string[]) => deCentimos(montos.reduce((t, m) => t + aCentimos(m), 0n))
    const delEvento = this.gastos.filter((g) => g.eventId === eventId)
    return Promise.resolve({
      assigned: suma(
        this.proveedores
          .filter((p) => p.eventId === eventId && p.status !== 'CANCELLED' && p.assignedBudget !== null)
          .map((p) => p.assignedBudget ?? '0'),
      ),
      paid: suma(delEvento.filter((g) => g.status === 'PAID').map((g) => g.amount)),
      pending: suma(delEvento.filter((g) => g.status === 'PENDING').map((g) => g.amount)),
    })
  }

  private aDominio(gasto: GastoEnMemoria): Expense {
    const origen: OrigenGasto =
      gasto.origen.kind === 'vendor'
        ? {
            kind: 'vendor',
            eventVendorId: gasto.origen.eventVendorId,
            vendorName: this.proveedores.find((p) => p.id === gasto.origen.eventVendorId)?.name ?? '',
          }
        : gasto.origen
    return { ...gasto, origen }
  }
}
```

TypeScript no estrecha `gasto.origen` dentro del callback de `find`. Hay que guardar antes `const { eventVendorId } = gasto.origen` en la rama `vendor`.

`infrastructure/prisma-expense.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { clienteDe } from '@/modules/database/transaccion'
import { PrismaService } from '@/modules/database/prisma.service'
import { encodeCursor, type CursorPage, type CursorValue } from '@/shared/domain'

import type {
  CambiosGasto,
  DatosNuevoGasto,
  ExpenseRepository,
  FiltroGastos,
  OrigenEntrada,
  SumasPresupuesto,
} from '../application/expense.repository'
import type { Expense } from '../domain/expense'
import { GastoNoEncontradoError } from '../domain/expense-errors'

const CON_PROVEEDOR = {
  eventVendor: {
    select: { externalName: true, vendorProfile: { select: { businessName: true } } },
  },
} satisfies Prisma.ExpenseInclude

type Fila = Prisma.ExpenseGetPayload<{ include: typeof CON_PROVEEDOR }>

function columnasOrigen(origen: OrigenEntrada | undefined): { eventVendorId?: string | null; payeeName?: string | null } {
  if (origen === undefined) return {}
  // Se escriben las DOS columnas siempre: cambiar de origen tiene que vaciar
  // la otra, o el CHECK `expenses_origen_exclusivo` rechaza la fila.
  return origen.kind === 'vendor'
    ? { eventVendorId: origen.eventVendorId, payeeName: null }
    : { eventVendorId: null, payeeName: origen.payeeName }
}

@Injectable()
export class PrismaExpenseRepository implements ExpenseRepository {
  constructor(private readonly prisma: PrismaService) {}

  async proveedorExiste(eventId: string, eventVendorId: string): Promise<boolean> {
    return (await this.prisma.eventVendor.count({ where: { id: eventVendorId, eventId } })) > 0
  }

  async crear(datos: DatosNuevoGasto): Promise<Expense> {
    const fila = await clienteDe(this.prisma).expense.create({
      data: {
        eventId: datos.eventId,
        ...columnasOrigen(datos.origen),
        concept: datos.concept,
        category: datos.category,
        amount: datos.amount,
        status: datos.status,
        paidAt: datos.paidAt,
        dueDate: datos.dueDate,
        notes: datos.notes,
        createdById: datos.createdById,
      },
      include: CON_PROVEEDOR,
    })
    return aDominio(fila)
  }

  async buscarPorId(eventId: string, expenseId: string): Promise<Expense | null> {
    const fila = await this.prisma.expense.findFirst({ where: { id: expenseId, eventId }, include: CON_PROVEEDOR })
    return fila === null ? null : aDominio(fila)
  }

  async listar(eventId: string, filtro: FiltroGastos, cursor: CursorValue | null, limit: number): Promise<CursorPage<Expense>> {
    const filas = await this.prisma.expense.findMany({
      where: {
        eventId,
        ...(filtro.status !== null ? { status: filtro.status } : {}),
        ...(filtro.origin === 'vendor' ? { eventVendorId: { not: null } } : {}),
        ...(filtro.origin === 'external' ? { eventVendorId: null } : {}),
        ...(filtro.eventVendorId !== null ? { eventVendorId: filtro.eventVendorId } : {}),
        ...(cursor !== null
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: CON_PROVEEDOR,
    })
    const items = filas.slice(0, limit)
    const ultimo = items.at(-1)
    return {
      items: items.map(aDominio),
      nextCursor:
        filas.length > limit && ultimo !== undefined
          ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id })
          : null,
    }
  }

  async actualizar(eventId: string, expenseId: string, cambios: CambiosGasto): Promise<Expense> {
    const cliente = clienteDe(this.prisma)
    const { count } = await cliente.expense.updateMany({
      where: { id: expenseId, eventId },
      data: {
        ...columnasOrigen(cambios.origen),
        ...(cambios.concept !== undefined ? { concept: cambios.concept } : {}),
        ...(cambios.category !== undefined ? { category: cambios.category } : {}),
        ...(cambios.amount !== undefined ? { amount: cambios.amount } : {}),
        ...(cambios.status !== undefined ? { status: cambios.status } : {}),
        ...(cambios.paidAt !== undefined ? { paidAt: cambios.paidAt } : {}),
        ...(cambios.dueDate !== undefined ? { dueDate: cambios.dueDate } : {}),
        ...(cambios.notes !== undefined ? { notes: cambios.notes } : {}),
      },
    })
    if (count === 0) throw new GastoNoEncontradoError()
    const fila = await cliente.expense.findFirst({ where: { id: expenseId, eventId }, include: CON_PROVEEDOR })
    if (fila === null) throw new GastoNoEncontradoError()
    return aDominio(fila)
  }

  async eliminar(eventId: string, expenseId: string): Promise<boolean> {
    const { count } = await clienteDe(this.prisma).expense.deleteMany({ where: { id: expenseId, eventId } })
    return count > 0
  }

  async sumas(eventId: string): Promise<SumasPresupuesto> {
    const [asignado, porEstado] = await Promise.all([
      this.prisma.eventVendor.aggregate({
        where: { eventId, status: { not: 'CANCELLED' } },
        _sum: { assignedBudget: true },
      }),
      this.prisma.expense.groupBy({ by: ['status'], where: { eventId }, _sum: { amount: true } }),
    ])
    const de = (status: 'PAID' | 'PENDING') =>
      (porEstado.find((g) => g.status === status)?._sum.amount ?? new Prisma.Decimal(0)).toFixed(2)
    return {
      assigned: (asignado._sum.assignedBudget ?? new Prisma.Decimal(0)).toFixed(2),
      paid: de('PAID'),
      pending: de('PENDING'),
    }
  }
}

function aDominio(fila: Fila): Expense {
  return {
    id: fila.id,
    eventId: fila.eventId,
    origen:
      fila.eventVendorId !== null
        ? {
            kind: 'vendor',
            eventVendorId: fila.eventVendorId,
            vendorName: fila.eventVendor?.vendorProfile?.businessName ?? fila.eventVendor?.externalName ?? '',
          }
        : { kind: 'external', payeeName: fila.payeeName ?? '' },
    concept: fila.concept,
    category: fila.category,
    amount: fila.amount.toFixed(2),
    status: fila.status,
    dueDate: fila.dueDate,
    paidAt: fila.paidAt,
    notes: fila.notes,
    createdById: fila.createdById,
    createdAt: fila.createdAt,
    updatedAt: fila.updatedAt,
  }
}
```

`dueDate` es una columna `@db.Date`: Prisma la devuelve como `Date` a medianoche UTC. El controlador la serializa como `YYYY-MM-DD` (Tarea 13).

`infrastructure/expense.repository.paridad.test.ts` sigue el patrón de la Tarea 6. Siembra en Postgres un usuario, un evento y dos `eventVendor` (uno CANCELLED con `assignedBudget: 999`), y copia al doble los mismos proveedores con el mismo `id`. Los casos corren contra los dos sujetos:
- crear gasto de vendor y externo y comparar `origen`, `amount` y `status`;
- `listar` con cada filtro (`status`, `origin`, `eventVendorId`) y paginar con `limit: 1` hasta `nextCursor === null`, comparando los `concept`. Para que el orden por `createdAt` sea determinista, se crean los gastos con `prisma.expense.create({ data: { ..., createdAt } })` y en el doble se empujan con el mismo `createdAt`, en lugar de usar `crear`.
- `actualizar` cambiando el origen de vendor a externo (valida el CHECK);
- `sumas` con montos `0.10` + `0.20`, que dan `'0.30'`, y `assigned` sin el CANCELLED.

- [ ] **Step 7: Ejecutar**

Run: `npm run typecheck && npm run lint:arch && npx vitest run src/modules/expenses`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/expenses
git commit -m "feat: dominio, repositorio y casos de uso de gastos del evento

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: API de gastos y resumen de presupuesto

**Files:**
- Create: `src/modules/expenses/interfaces/expenses.dto.ts` (+ `.test.ts`) y `expenses.controller.ts`
- Create: `src/modules/expenses/expenses.module.ts`
- Modify: `src/app.module.ts`
- Create: `test/e2e/expenses.e2e.test.ts`

**Interfaces:**
- Consumes: los casos de uso de la Tarea 12 y `montoSchema` de `@/shared/http/esquemas`.
- Produces:
  - Rutas bajo `events/:eventId/expenses`: `GET` (query `status`, `origin`, `eventVendorId`, `cursor`, `limit` → `{ items: GastoRespuesta[], nextCursor }`), `POST` (201), `PATCH /:expenseId` y `DELETE /:expenseId` (204).
  - `GET /events/:eventId/budget-summary` → `ResumenPresupuesto`.
  - Todas las rutas son para COUPLE y PLANNER.

```ts
interface GastoRespuesta {
  id: string
  origin: { kind: 'vendor'; eventVendorId: string; vendorName: string } | { kind: 'external'; payeeName: string }
  concept: string; category: string; amount: string; status: 'PENDING' | 'PAID'
  dueDate: string | null   // YYYY-MM-DD
  paidAt: string | null
  notes: string | null
  createdAt: string
}
// Body POST: { concept, category, amount, eventVendorId?: uuid, payeeName?: string, dueDate?: 'YYYY-MM-DD' | null, status?, notes? }
// exactamente uno de eventVendorId / payeeName (400 si ninguno o ambos)
```

- [ ] **Step 1: Tests del DTO que fallan**

`expenses.dto.test.ts`:

```ts
import { createExpenseSchema, updateExpenseSchema } from './expenses.dto'

const base = { concept: 'Anticipo', category: 'Music', amount: 200 }

describe('createExpenseSchema', () => {
  it('externo con monto normalizado y origen construido', () => {
    expect(createExpenseSchema.parse({ ...base, payeeName: ' Imprenta ' })).toMatchObject({
      amount: '200.00',
      origen: { kind: 'external', payeeName: 'Imprenta' },
    })
  })

  it.each([
    [{ ...base }],
    [{ ...base, payeeName: 'X', eventVendorId: '33333333-3333-4333-8333-333333333333' }],
    [{ ...base, payeeName: 'X', amount: 0 }],
    [{ ...base, payeeName: 'X', amount: '12.345' }],
    [{ ...base, payeeName: 'X', dueDate: '2027-13-01' }],
    [{ ...base, eventVendorId: 'no-uuid' }],
  ])('rechaza %o', (entrada) => {
    expect(createExpenseSchema.safeParse(entrada).success).toBe(false)
  })
})

describe('updateExpenseSchema', () => {
  it('exige al menos un cambio y no acepta paidAt', () => {
    expect(updateExpenseSchema.safeParse({}).success).toBe(false)
    expect(updateExpenseSchema.safeParse({ paidAt: '2027-01-01' }).success).toBe(false)
  })

  it('cambiar a externo construye el origen', () => {
    expect(updateExpenseSchema.parse({ payeeName: 'Otro' })).toEqual({
      origen: { kind: 'external', payeeName: 'Otro' },
    })
  })
})
```

- [ ] **Step 2: Ejecutar**

Run: `npx vitest run src/modules/expenses/interfaces`
Expected: FAIL.

- [ ] **Step 3: Implementar el DTO**

`expenses.dto.ts`:

```ts
import { z } from 'zod'

import { montoSchema } from '@/shared/http/esquemas'

/** Monto de un gasto: estrictamente positivo (el CHECK de la tabla también lo exige). */
const montoPositivo = montoSchema.refine((m) => m !== '0.00', { message: 'El monto debe ser mayor que 0' })
const fechaDia = z.iso.date().transform((d) => new Date(`${d}T00:00:00.000Z`))
const estado = z.enum(['PENDING', 'PAID'])

const origenCampos = {
  eventVendorId: z.uuid().optional(),
  payeeName: z.string().trim().min(1).max(200).optional(),
}

type OrigenCrudo = { eventVendorId?: string | undefined; payeeName?: string | undefined }

function origenDe(d: OrigenCrudo) {
  if (d.eventVendorId !== undefined) return { kind: 'vendor' as const, eventVendorId: d.eventVendorId }
  if (d.payeeName !== undefined) return { kind: 'external' as const, payeeName: d.payeeName }
  return undefined
}

const unSoloOrigen = (d: OrigenCrudo) => !(d.eventVendorId !== undefined && d.payeeName !== undefined)

export const createExpenseSchema = z
  .object({
    concept: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(100),
    amount: montoPositivo,
    dueDate: fechaDia.nullable().optional(),
    status: estado.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    ...origenCampos,
  })
  .strict()
  .refine((d) => unSoloOrigen(d) && origenDe(d) !== undefined, {
    message: 'Indica exactamente uno: eventVendorId o payeeName',
  })
  .transform(({ eventVendorId, payeeName, ...resto }) => {
    const origen = origenDe({ eventVendorId, payeeName })
    // El refine garantiza que existe; el `if` es para el tipo.
    if (origen === undefined) throw new Error('origen ausente tras validar')
    return { ...resto, origen }
  })

export const updateExpenseSchema = z
  .object({
    concept: z.string().trim().min(1).max(200).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    amount: montoPositivo.optional(),
    dueDate: fechaDia.nullable().optional(),
    status: estado.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    ...origenCampos,
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Indica al menos un cambio' })
  .refine(unSoloOrigen, { message: 'Indica solo uno: eventVendorId o payeeName' })
  .transform(({ eventVendorId, payeeName, ...resto }) => {
    const origen = origenDe({ eventVendorId, payeeName })
    return origen === undefined ? resto : { ...resto, origen }
  })

export const listExpensesQuerySchema = z.object({
  status: estado.optional(),
  origin: z.enum(['vendor', 'external']).optional(),
  eventVendorId: z.uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})
```

- [ ] **Step 4: Controlador y módulo**

`expenses.controller.ts`:

```ts
@UseGuards(JwtAuthGuard, EventAccessGuard)
@Controller('events/:eventId')
export class ExpensesController {
  constructor(
    private readonly listar: ListExpensesUseCase,
    private readonly crear: CreateExpenseUseCase,
    private readonly actualizar: UpdateExpenseUseCase,
    private readonly eliminar: DeleteExpenseUseCase,
    private readonly resumen: BudgetSummaryUseCase,
  ) {}

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get('expenses')
  async listarGastos(
    @Param('eventId') eventId: string,
    @Query() query: unknown,
  ): Promise<{ items: GastoRespuesta[]; nextCursor: string | null }> {
    const q = validarCon(listExpensesQuerySchema, query)
    const pagina = await this.listar.ejecutar(
      eventId,
      { status: q.status ?? null, origin: q.origin ?? null, eventVendorId: q.eventVendorId ?? null },
      q.cursor === undefined ? null : decodeCursor(q.cursor),
      q.limit,
    )
    return { items: pagina.items.map(aRespuesta), nextCursor: pagina.nextCursor }
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Post('expenses')
  async crearGasto(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<GastoRespuesta> {
    const yo = exigirUsuario(usuario)
    const d = validarCon(createExpenseSchema, body)
    return aRespuesta(
      await this.crear.ejecutar(
        eventId,
        {
          origen: d.origen,
          concept: d.concept,
          category: d.category,
          amount: d.amount,
          dueDate: d.dueDate ?? null,
          notes: d.notes ?? null,
          status: d.status,
        },
        yo.id,
      ),
    )
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Patch('expenses/:expenseId')
  async editarGasto(
    @Param('eventId') eventId: string,
    @Param('expenseId') expenseId: string,
    @Body() body: unknown,
  ): Promise<GastoRespuesta> {
    const id = idDeRuta(expenseId, () => new GastoNoEncontradoError())
    return aRespuesta(await this.actualizar.ejecutar(eventId, id, validarCon(updateExpenseSchema, body)))
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Delete('expenses/:expenseId')
  @HttpCode(204)
  async borrarGasto(@Param('eventId') eventId: string, @Param('expenseId') expenseId: string): Promise<void> {
    await this.eliminar.ejecutar(eventId, idDeRuta(expenseId, () => new GastoNoEncontradoError()))
  }

  @RequireEventAccess('COUPLE', 'PLANNER')
  @Get('budget-summary')
  async verResumen(@Param('eventId') eventId: string): Promise<ResumenPresupuesto> {
    return await this.resumen.ejecutar(eventId)
  }
}

function aRespuesta(g: Expense): GastoRespuesta {
  return {
    id: g.id,
    origin: g.origen,
    concept: g.concept,
    category: g.category,
    amount: g.amount,
    status: g.status,
    dueDate: g.dueDate?.toISOString().slice(0, 10) ?? null,
    paidAt: g.paidAt?.toISOString() ?? null,
    notes: g.notes,
    createdAt: g.createdAt.toISOString(),
  }
}

function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}
```

Los imports salen de los mismos sitios que en `event-vendors.controller.ts`, más `Query`, `Patch`, `Delete`, `HttpCode` y `decodeCursor`.

`expenses.module.ts`: `imports: [AuthModule, UsersModule, EventsModule]`. `EventsModule` exporta `EVENT_REPOSITORY`, que usa `BudgetSummaryUseCase`. Providers: `EXPENSE_REPOSITORY` con `useFactory` sobre `PrismaService` y los 5 casos de uso. Controllers: `ExpensesController`. Registrar `ExpensesModule` en `src/app.module.ts`.

- [ ] **Step 5: e2e**

`test/e2e/expenses.e2e.test.ts`, con el arranque de `event-vendors.e2e.test.ts` y `crearEventoPublicado`:

```ts
  it('flujo completo: gasto de vendor, externo, pagar, filtrar, resumen y 409 al borrar vendor', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    const vendor = await request(url)
      .post(`/events/${evento}/vendors`)
      .set(auth)
      .send({ externalName: 'DJ Max', category: 'Music', assignedBudget: 500 })
      .expect(201)
    const vendorId = (vendor.body as { id: string }).id

    const deVendor = await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'Anticipo DJ', category: 'Music', amount: '200', eventVendorId: vendorId, dueDate: '2027-05-01' })
      .expect(201)
    expect(deVendor.body).toMatchObject({
      origin: { kind: 'vendor', eventVendorId: vendorId, vendorName: 'DJ Max' },
      amount: '200.00',
      status: 'PENDING',
      dueDate: '2027-05-01',
      paidAt: null,
    })

    await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'Invitaciones', category: 'Stationery', amount: 80.5, payeeName: 'Imprenta', status: 'PAID' })
      .expect(201)

    const pagado = await request(url)
      .patch(`/events/${evento}/expenses/${(deVendor.body as { id: string }).id}`)
      .set(auth)
      .send({ status: 'PAID' })
      .expect(200)
    expect((pagado.body as { paidAt: string | null }).paidAt).not.toBeNull()

    const externos = await request(url).get(`/events/${evento}/expenses?origin=external`).set(auth).expect(200)
    expect((externos.body as { items: unknown[] }).items).toHaveLength(1)

    const resumen = await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(200)
    expect(resumen.body).toEqual({
      currency: 'USD',
      totalBudget: '10000.00',
      assigned: '500.00',
      unassigned: '9500.00',
      paid: '280.50',
      pending: '0.00',
      remaining: '9719.50',
    })

    await request(url).delete(`/events/${evento}/vendors/${vendorId}`).set(auth).expect(409)
  })

  it('eventVendorId de otro evento → 404; no-uuid → 400; extraño → 404', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    const otroEvento = await crearEventoPublicado(url, ana.accessToken, 'Otra boda')
    const ajeno = await request(url)
      .post(`/events/${otroEvento}/vendors`)
      .set(auth)
      .send({ externalName: 'Ajeno', category: 'X' })
      .expect(201)

    await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'X', category: 'X', amount: 1, eventVendorId: (ajeno.body as { id: string }).id })
      .expect(404)
    await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'X', category: 'X', amount: 1, eventVendorId: 'no-uuid' })
      .expect(400)
    await request(url)
      .get(`/events/${evento}/expenses`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)
  })
```

Aquí `evento` se crea en `beforeAll` con `crearEventoPublicado`, que usa `totalBudget: 10000` y `currency: 'USD'`.

- [ ] **Step 6: Ejecutar**

Run: `npm run typecheck && npm run lint && npx vitest run src/modules/expenses test/e2e/expenses.e2e.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/expenses src/app.module.ts test/e2e/expenses.e2e.test.ts
git commit -m "feat: endpoints de gastos y resumen de presupuesto del evento

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Verificación completa y PR

**Files:** ninguno nuevo. Solo se corrige lo que salga en la verificación.

- [ ] **Step 1: Pipeline completo en local, en el mismo orden que CI**

```bash
npm run typecheck
npm run lint
npx prettier --check .
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code
npm test
npm run build && npm run test:smoke
```

Expected: todo en verde. Si prettier falla, se ejecuta `npm run format` y se revisa el diff antes de commitear.

- [ ] **Step 2: Revisar Swagger**

Arrancar con `npm run start:dev` y abrir `/docs`. Hay que comprobar que aparecen las rutas nuevas: `PATCH /events/{eventId}`, `POST /events/{eventId}/publish`, `/events/{eventId}/schedule`, `/events/{eventId}/expenses`, `/events/{eventId}/budget-summary` y `/vendors`.

- [ ] **Step 3: Push y PR contra `main`**

```bash
git push -u origin feat/crear-evento
gh pr create --base main --title "feat: borradores de evento, cronograma, catálogo de proveedores y gastos" --body "$(cat <<'EOF'
## Resumen
- Eventos en `DRAFT` desde el primer guardado (solo nombre obligatorio), `PATCH` parcial en cualquier estado y `POST /publish` con 422 `EVENT_INCOMPLETE` + `details.faltantes`.
- Lugar con coordenadas (Mapbox) en el evento y en cada ítem del cronograma.
- Cronograma con estado `PENDING | IN_PROGRESS | DONE`.
- Catálogo `GET /vendors` de perfiles publicados.
- Gastos ligados a un proveedor del evento o a un beneficiario externo, con `GET /budget-summary`.
- Montos como strings decimales; `assignedBudget` pasa de number a string.
- Un vendor BOOKED no ve eventos en borrador.

Spec: `docs/superpowers/specs/2026-09-24-crear-evento-design.md`

## Pruebas
- Unitarias, paridad fake↔Prisma, restricciones del esquema y e2e nuevos (`events-draft`, `schedule`, `vendor-catalog`, `expenses`).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
