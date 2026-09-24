# Crear evento: borradores, wizard, cronograma y gastos (backend + frontend)

> Diseño aprobado en conversación el 2026-09-24. Ramas `feat/crear-evento` desde
> `main` en `wedding-planner-backend` y `wedding-planner-frontend`, con PR contra
> `main`.

## 1. Alcance

La persona crea un evento desde una vista dentro del layout con Sidebar, igual
que el dashboard. Lo hace con un wizard por pasos **no bloqueantes**: puede
saltar a cualquier paso en cualquier orden. Lo que carga se guarda como
**borrador en el servidor** y se retoma desde cualquier dispositivo. Un evento
publicado sigue **totalmente editable** con el mismo wizard. Los gastos se
registran después, en una vista propia.

Los campos salen de la vista de configuración (`EventSettingsScreen`: fecha,
presupuesto total, venue y proveedores asignados), ampliados con lo que pidió
el usuario.

Decisiones del usuario:

- **Borrador en el servidor.** El evento nace en `DRAFT` en el primer guardado.
  Solo el nombre es obligatorio para guardar; el resto se exige al publicar.
- **Pasos no bloqueantes.** Ningún paso depende de otro. Cada uno guarda por su
  cuenta.
- **Editable siempre.** En `ACTIVE` se puede cambiar todo, moneda incluida. La
  única restricción es no dejar vacío un campo obligatorio para publicar.
- **Mapa: Mapbox.** El lugar se elige con autocompletado de direcciones y un
  pin arrastrable. Se guardan nombre, dirección, coordenadas e id de Mapbox.
- **Cronograma.** Cada ítem tiene título, inicio, fin opcional, descripción,
  lugar propio opcional (si falta, se usa el del evento) y estado
  `PENDING | IN_PROGRESS | DONE` para seguirlo hasta terminarlo.
- **Presupuesto** = total del evento + `assignedBudget` por proveedor (ya
  existe en `EventVendor`).
- **Una moneda por evento** (ISO 4217). No hay conversiones: cambiar la moneda
  no toca los montos, y la UI lo advierte.
- **Proveedores:** de la plataforma (hace falta un catálogo básico de
  `VendorProfile` `PUBLISHED`) o externos.
- **Gastos:** se registran después de crear el evento, en su vista. Cada uno
  va ligado a un proveedor del evento o a un beneficiario externo.
- **Selector de evento en el Sidebar**, con eventos, borradores y
  "+ Create event". El `eventId` vive en la URL.

Fuera de alcance:

- Conversión de moneda y multimoneda dentro de un evento.
- Partidas de presupuesto por categoría.
- Vincular un ítem del cronograma a un proveedor.
- Adjuntos y facturas en los gastos.
- Marketplace completo de proveedores: el catálogo es solo búsqueda.
- Pasar de `ACTIVE` a `DRAFT` y borrar eventos.
- Conectar el dashboard a datos reales: sigue con mocks, pero ahora vive bajo
  `/events/:eventId/dashboard`.

## 2. Modelo de datos

Migración nueva `add_event_draft_schedule_expenses`.

### 2.1 `Event` (cambios)

```prisma
enum EventStatus {
  DRAFT
  ACTIVE
}

model Event {
  // ...existentes
  status        EventStatus @default(DRAFT)
  weddingDate   DateTime?                 // antes obligatoria
  currency      String      @default("USD") @db.Char(3)
  totalBudget   Decimal?    @db.Decimal(12, 2)
  venueName     String?
  venueAddress  String?
  venueLat      Decimal?    @db.Decimal(9, 6)
  venueLng      Decimal?    @db.Decimal(9, 6)
  venueMapboxId String?
  // venueLocation se elimina (ver migración)
  scheduleItems ScheduleItem[]
  expenses      Expense[]
}
```

Pasos de la migración SQL:

1. Se crea `status` con default `'ACTIVE'` para que las filas existentes queden
   publicadas. Después se cambia el default a `'DRAFT'`.
2. `venueAddress = venueLocation` y luego `DROP COLUMN venueLocation`.
3. CHECKs escritos a mano, porque Prisma no los modela:
   - `events_venue_coords`: `(venueLat IS NULL) = (venueLng IS NULL)`, lat en
     [-90, 90] y lng en [-180, 180].
   - `events_total_budget_no_negativo`: `totalBudget IS NULL OR totalBudget >= 0`.
   - `events_activo_con_fecha`: `status = 'DRAFT' OR weddingDate IS NOT NULL`.

   Es la red de seguridad; la regla completa de publicación vive en el dominio
   (§4).

### 2.2 `ScheduleItem`

```prisma
enum ScheduleItemStatus {
  PENDING
  IN_PROGRESS
  DONE
}

model ScheduleItem {
  id                String             @id @default(uuid()) @db.Uuid
  eventId           String             @db.Uuid
  title             String
  description       String?
  startsAt          DateTime
  endsAt            DateTime?
  locationName      String?
  locationAddress   String?
  locationLat       Decimal?           @db.Decimal(9, 6)
  locationLng       Decimal?           @db.Decimal(9, 6)
  locationMapboxId  String?
  status            ScheduleItemStatus @default(PENDING)
  createdAt         DateTime           @default(now())
  updatedAt         DateTime           @updatedAt

  event Event @relation(fields: [eventId], references: [id], onDelete: Cascade)

  @@index([eventId, startsAt])
  @@map("schedule_items")
}
```

CHECKs:
- `schedule_items_rango`: `endsAt IS NULL OR endsAt >= startsAt`.
- `schedule_items_coords`: igual que el de eventos.

`startsAt` y `endsAt` son instantes UTC. El frontend los muestra y los captura
en la `timezone` del evento.

### 2.3 `Expense`

```prisma
enum ExpenseStatus {
  PENDING
  PAID
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
  createdBy   User         @relation(fields: [createdById], references: [id])

  @@index([eventId, createdAt, id])
  @@index([eventVendorId])
  @@map("expenses")
}
```

CHECKs:
- `expenses_monto_positivo`: `amount > 0`.
- `expenses_origen_exclusivo`: exactamente uno de `eventVendorId` y
  `payeeName` es no nulo. Es el mismo patrón que
  `event_vendors_origen_exclusivo`.
- `expenses_pagado_con_fecha`: `(status = 'PAID') = (paidAt IS NOT NULL)`.

`docs/DATABASE.md` se actualiza con las tres tablas y sus CHECKs.

## 3. Dominio compartido: `Ubicacion`

`src/shared/domain/ubicacion.ts` es un value object inmutable con `name?`,
`address`, `lat`, `lng` y `mapboxId?`. Sus reglas:

- `address` no puede estar vacía.
- lat y lng son números finitos dentro de rango.

Va en `shared/domain` y no en `events/domain`: también lo usa `schedule`, y
dependency-cruiser prohíbe que un módulo entre en el `domain` de otro.

Las coordenadas llegan y salen como `number`, porque 6 decimales (unos 11 cm)
caben de sobra en un double. En la base de datos se guardan en `Decimal(9,6)`
para que no aparezca ruido al leerlas.

## 4. Regla de publicación

`src/modules/events/domain/publicacion.ts` exporta
`camposFaltantesParaPublicar(evento): CampoPublicable[]`, con
`CampoPublicable = 'name' | 'weddingDate' | 'timezone' | 'currency' | 'totalBudget' | 'venue'`.
`venue` falta si no hay dirección **o** no hay coordenadas.

Se aplica en dos lugares:

- `POST /events/:id/publish` → si la lista no está vacía, lanza
  `EventoIncompletoError` (422), con `details: { faltantes }`.
- `PATCH /events/:id` sobre un evento `ACTIVE` → se calcula con el resultado
  del parche. Si queda algo faltante, lanza el mismo 422 y no persiste nada.

`DomainError` hoy no tiene `details`. Se le agrega un `readonly details?: unknown`
opcional en el constructor, y `domain-exception.filter.ts` lo serializa en el
campo `details` que el cuerpo de error ya contempla.

`completitud` se calcula en el dominio y va en cada respuesta de evento:

```ts
{ general: 'completo' | 'parcial' | 'vacio',
  venue:   'completo' | 'vacio',
  schedule: 'completo' | 'vacio',   // ≥1 ítem
  budget:  'completo' | 'parcial' | 'vacio' } // total y ≥1 proveedor
```

`completitud` solo alimenta el stepper; publicar exige la lista de §4, no los
pasos de cronograma ni proveedores.

## 5. Endpoints

Todos van con `JwtAuthGuard`. Los que llevan `:eventId` usan además
`EventAccessGuard` con `@RequireEventAccess('COUPLE', 'PLANNER')`. Sin acceso
la respuesta es 404, nunca 403. Los ids de ruta se validan con `idDeRuta`.

**Montos:** en la respuesta son strings decimales con dos decimales (`"45000.00"`);
en la petición se aceptan como number o string y zod los normaliza a
`Decimal(12,2)`. `assignedBudget` de los proveedores pasa de number a string
para ser coherente. El frontend todavía no consume ese endpoint, así que el
cambio de contrato no rompe nada.

### 5.1 Eventos (`events`)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/events` | Crea un `DRAFT`. Body: `name` (obligatorio), `weddingDate?`, `timezone?`, `currency?`, `totalBudget?`, `venue?`. |
| GET | `/events` | Eventos accesibles, con `status` y `completitud`. |
| GET | `/events/:eventId` | Detalle. Los VENDOR no ven eventos en `DRAFT` (404). |
| PATCH | `/events/:eventId` | Actualización parcial, en cualquier estado. `venue: null` borra el lugar; `weddingDate: null` y `totalBudget: null` borran esos campos. En `ACTIVE`, aplica la regla de §4. |
| POST | `/events/:eventId/publish` | `DRAFT` → `ACTIVE`. Es idempotente: sobre un `ACTIVE` devuelve 200 sin cambios. |

Validaciones zod, en `events.dto.ts`:

- `timezone` debe estar en `Intl.supportedValuesOf('timeZone')` o ser `'UTC'`.
- `currency` es un enum de códigos ISO 4217 soportados. Una lista inicial
  acotada (USD, EUR, MXN, COP, ARS, CLP, PEN, BRL, GBP, CAD) es suficiente, y
  el frontend usa la misma.
- `totalBudget` debe ser >= 0 y tener como máximo 10 dígitos enteros.
- `venue` sigue la forma de `Ubicacion`.
- `name` va de 1 a 200 caracteres, tras `trim`.

Forma de la respuesta:

```ts
{ id, name, status, weddingDate: string | null, timezone, currency,
  totalBudget: string | null,
  venue: { name, address, lat, lng, mapboxId } | null,
  completitud, rsvpDeadlineDays, createdAt, updatedAt }
```

`buscarContratacionReservada` pasa a filtrar `event.status = 'ACTIVE'`. Así,
un proveedor contratado en un borrador no obtiene acceso al evento.

### 5.2 Cronograma (módulo nuevo `schedule`)

Rutas bajo `events/:eventId/schedule`:

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | Todos los ítems, ordenados por `startsAt` y luego `id`. Sin paginación: un evento tiene decenas de ítems, no miles. |
| POST | `/` | Body: `title`, `startsAt`, `endsAt?`, `description?`, `location?`, `status?`. |
| PATCH | `/:itemId` | Parcial; incluye `status`. `location: null` vuelve a usar el lugar del evento. |
| DELETE | `/:itemId` | 204. |

Si `endsAt < startsAt`, responde 400 desde zod en la creación. En un PATCH se
compara contra el valor ya guardado y responde 422
(`RangoDeCronogramaInvalidoError`).

Un ítem de otro evento responde 404 (`ItemDeCronogramaNoEncontradoError`).

### 5.3 Catálogo de proveedores (módulo `vendors`)

`GET /vendors?category=&q=&cursor=&limit=` en `VendorCatalogController`,
para cualquier usuario autenticado:

- Solo perfiles `PUBLISHED`.
- `q` busca sin distinguir mayúsculas en `businessName` y `specialty`.
- Paginación por cursor con `src/shared/domain/cursor.ts`; `limit` por defecto
  20 y máximo 50.
- Limitador `@LimiteDeRuta` de 60 por minuto y usuario.
- Respuesta: `{ items: [{ id, businessName, category, specialty }], nextCursor }`.

`DELETE /events/:eventId/vendors/:eventVendorId` sobre un proveedor con gastos
responde 409 `ProveedorConGastosError`. El mensaje sugiere pasarlo a
`CANCELLED`.

### 5.4 Gastos (módulo nuevo `expenses`)

Rutas bajo `events/:eventId/expenses`:

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | Filtros `status?` y `origin?` (`vendor` o `external`), `eventVendorId?`, `cursor` y `limit`. Orden `createdAt desc, id`. |
| POST | `/` | Body: `concept`, `category`, `amount`, `eventVendorId` **o** `payeeName`, `dueDate?`, `status?`, `notes?`. |
| PATCH | `/:expenseId` | Parcial. Al pasar a `PAID` fija `paidAt = now()`; al volver a `PENDING` lo limpia. Se puede cambiar de origen, reemplazando uno por otro. |
| DELETE | `/:expenseId` | 204. |

`GET /events/:eventId/budget-summary` devuelve:

```ts
{ currency, totalBudget: string | null,
  assigned,    // Σ assignedBudget de EventVendor no CANCELLED
  unassigned,  // totalBudget − assigned (null si no hay total)
  paid,        // Σ amount PAID
  pending,     // Σ amount PENDING
  remaining }  // totalBudget − paid − pending (null si no hay total)
```

Todos los montos del resumen son strings decimales. Se calculan con
`aggregate` en el repositorio y la aritmética se hace con `Prisma.Decimal`.

Validaciones:

- Un `eventVendorId` que no pertenece al evento → 404
  `ProveedorDelEventoNoEncontradoError`.
- Mandar los dos orígenes o ninguno → 400.
- `amount` debe ser mayor que 0.

## 6. Capas backend

Se sigue el patrón de `vendors` y `auth`:

- Cada use case tiene un método `ejecutar`.
- El puerto es una interfaz con su Symbol.
- Adaptadores Prisma que escriben con `clienteDe(this.prisma)`.
- Fakes `*.fake.ts` con test de paridad.
- Errores de dominio en español.

Módulos:

- `events`: `update-event.use-case` y `publish-event.use-case`. Se amplía
  `create-event`, y `EventRepository` suma `actualizar`.
- `schedule`: módulo nuevo. Importa `AuthModule`, `UsersModule` y
  `EventsModule` por el guard.
- `expenses`: módulo nuevo, con los mismos imports. La consulta de "¿este
  EventVendor es del evento?" pasa por un puerto propio de `expenses`
  implementado sobre Prisma. No importa la infraestructura de `vendors`.
- `vendors`: `search-vendor-catalog.use-case` y su controlador.
  `remove-event-vendor` consulta si hay gastos a través de un puerto; el
  adaptador Prisma cuenta en `expenses`.

## 7. Frontend

Reglas: CLAUDE.md y `design/README.md`.

- CVA + `forwardRef` + `XProps`.
- Sin valores arbitrarios, sin `dark:` y sin `slate-*`.
- Las pantallas solo ensamblan; no se usan `<button>` crudos en `features/`.
- Comentarios en español; textos de UI en inglés.
- Regla de dos pantallas para crear primitivas.
- `DESIGN-GAP` en cada desviación del export.

### 7.1 Infraestructura

- `api-client.ts`: se agregan `apiPatch` y `apiDelete`, y
  `ApiRequestError.details`.
- `events-api.ts`: funciones tipadas y esquemas zod de respuesta.
- `mapbox-gl`, con versión exacta y auditada antes de instalar. El geocoding
  usa la API v6 por `fetch`, en `src/lib/mapbox.ts`.
- `VITE_MAPBOX_TOKEN` en `.env.example`. Es un token público restringido por
  URL en el panel de Mapbox.
- Sin token, `LocationPicker` degrada a búsqueda desactivada más dirección
  manual y muestra un `Banner`; no rompe la pantalla.

### 7.2 Layout y rutas

- `AppLayout` = `Sidebar` + `<Outlet>`. `DashboardScreen` deja de montar el
  Sidebar.
- El nav tiene Dashboard, Event setup y Expenses con rutas reales. Guests,
  Seating y Timeline siguen como hash.
- `EventSwitcher` va sobre `DropdownMenu`: eventos con un `Badge` "Draft" en
  los borradores, y "+ Create event". La `action` del Sidebar es
  "Create event".
- Rutas dentro de `RequireAuth` → `AppLayout`:

| Ruta | Contenido |
|---|---|
| `/events/new` | Paso General sin id. El primer guardado hace POST y un `navigate(..., { replace: true })` a `/events/:id/setup/general`. |
| `/events/:eventId/setup/:step` | `general \| venue \| schedule \| budget \| review`. |
| `/events/:eventId/dashboard` | Dashboard, con mocks. |
| `/events/:eventId/expenses` | Vista de gastos. |
| `/dashboard` | Redirige al último evento usado (`localStorage`, dentro de try/catch), si no al primero, y si no hay ninguno a `/events/new`. El login y `/welcome` aterrizan aquí. |

### 7.3 Wizard `features/event-setup/`

- El `Stepper` sale de generalizar `booking/booking-progress.tsx` a
  `components/ui/stepper.tsx`, porque lo usan dos pantallas.
- Todos los pasos se pueden clicar. Cada uno muestra un indicador según
  `completitud`.
- Cada paso tiene su formulario (`useValidatedForm` con un esquema parcial) y
  el botón **Save draft**. Si el evento está en `ACTIVE`, el botón dice
  **Save changes**.
- Los cambios sin guardar se protegen con `useBlocker` y un `Modal` con tres
  opciones: Save, Discard y Cancel.
- Si el guardado devuelve 422 por vaciar un obligatorio, el error se muestra
  en el campo.

Pasos:

1. **General**: name*, date (`DateInput`), time zone (`Select`) y currency
   (`Select`). Cambiar la moneda con montos cargados pide confirmación.
2. **Venue**: `LocationPicker`, con buscador con autocompletado, mapa y pin
   arrastrable con reverse geocoding. Los campos venue name y address se
   pueden editar a mano.
3. **Schedule**: lista por hora en la zona del evento. Alta y edición en un
   `Modal`, con lugar "Same as venue" por defecto o un `LocationPicker`
   propio. `Badge` de estado con cambio rápido. Guarda inmediatamente.
4. **Budget & vendors**: total budget; lista de proveedores (reutiliza
   `settings/vendor-row.tsx`); "Add vendor" con `Tabs` *From platform* y
   *External*; `ProgressBar` de asignado frente a total.
5. **Review**: resumen por sección con "Edit", la lista de faltantes y
   **Publish event**. Si el evento ya está publicado, muestra "Published".

Primitivas nuevas en `components/ui/`, usadas por settings y event-setup:

- `select.tsx`: `<select>` nativo con `inputVariants`. Reemplaza los
  `<select>` crudos de `event-settings-screen`.
- `date-input.tsx`.

### 7.4 Gastos `features/expenses/`

- `StatCard` para Total budget, Paid, Pending y Remaining, con
  `Intl.NumberFormat` en la moneda del evento.
- `Table` con concepto, origen (vendor o "External · payee"), categoría,
  monto, vencimiento y `Badge` de estado, más la acción "Mark as paid".
- Filtros por estado y origen, y `Pagination`.
- `ExpenseFormModal` para alta y edición.
- Referencias: `design/stitch/interactive_budget_manager` e
  `invoice_payments_dashboard_*`.

## 8. Tests (TDD)

**Backend:**

- Unit tests:
  - `Ubicacion`, `camposFaltantesParaPublicar` y `completitud`.
  - Cada use case contra fakes: crear un borrador solo con nombre, PATCH
    parcial, PATCH en `ACTIVE` que vacía un obligatorio (422), cambio de
    moneda en `ACTIVE` (ok), publicación incompleta y completa, e idempotencia.
- Paridad fake ↔ Prisma e integración en Testcontainers para los repositorios
  nuevos.
- `schema.test.ts`: cada CHECK nuevo rechaza la fila inválida.
- E2E:
  - `events-draft.e2e`
  - `schedule.e2e`
  - `vendor-catalog.e2e`
  - `expenses.e2e`, que incluye `budget-summary` y el 409 al borrar un
    proveedor con gastos.
  - En todos: 404 sin acceso y 404 para un VENDOR sobre un `DRAFT`.
- Se ajusta el e2e existente de `POST /events`, que ya no exige fecha.

**Frontend:**

- `vi.mock` de `events-api` y de `mapbox-gl`, y `fetch` del geocoding
  mockeado.
- Casos:
  - Navegación libre del stepper.
  - Primer guardado con POST y reemplazo de URL; los siguientes con PATCH.
  - Aviso de cambios sin guardar.
  - Faltantes al publicar.
  - Edición de un `ACTIVE`, incluido el 422 en el campo.
  - `EventSwitcher` y la redirección de `/dashboard`.
  - `ExpensesScreen` y el modal de gasto.
- `LocationPicker` sin token.
- Se actualizan los tests de dashboard, booking-progress/stepper y
  `no-raw-buttons`.

## 9. Orden de entrega

1. Backend:
   1. Esquema y migración.
   2. `Ubicacion` y la regla de publicación.
   3. Eventos: crear, patch, publish y respuestas.
   4. Catálogo y 409 al borrar proveedor.
   5. Cronograma.
   6. Gastos y resumen.

   Un PR a `main`.
2. Frontend:
   1. api-client, `events-api` y primitivas.
   2. `AppLayout`, switcher y rutas.
   3. Wizard.
   4. Vista de gastos.

   Un PR a `main`.
