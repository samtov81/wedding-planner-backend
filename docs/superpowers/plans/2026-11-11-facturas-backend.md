# Facturas y pagos (backend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada gasto puede llevar los datos de su factura (número, subtotal, archivo opcional). Budget gana vencidos, próximos pagos y búsqueda. El proveedor cobrado ve sus gastos PAID, aunque su contratación esté cancelada, y recibe campana y tiempo real.

**Architecture:** Se amplía el módulo `expenses`:
- columnas nuevas en `expenses` con tres CHECK y un UNIQUE parcial;
- `storage` generaliza la subida directa a R2 para aceptar también facturas (PDF + imágenes);
- las escrituras pasan a `UnidadDeTrabajo` para crear la campana `expense.paid` dentro de la transacción;
- una cola propia `expenses`, con un worker que emite `expense.changed` / `vendor-payment.changed`;
- el proveedor tiene rutas propias bajo `/me/vendor-payments`, que filtran filas por `vendor_profile.userId` y `event_vendor.status IN (BOOKED, CANCELLED)`, sin pasar por `EventAccessGuard`.

**Tech Stack:** NestJS 11, Prisma 6 / Postgres 16, BullMQ, Socket.IO, Zod, `@aws-sdk/client-s3`, Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-11-11-facturas-design.md`. El plan hermano del frontend se ejecuta después y consume la §Contrato: `wedding-planner-frontend/docs/superpowers/plans/2026-11-11-facturas-frontend.md`.

## Global Constraints

- Rama `feat/facturas` (ya creada, con el spec commiteado). Sin push ni PR hasta el final. No hacer nunca stage de `.claude/settings.json` ni de `.superpowers/`.
- Comentarios, docblocks y `describe`/`it` en español; strings de API en inglés. Las decisiones se citan como "spec 2026-11-11 §N", con la alternativa descartada en el docblock.
- Gate de cada tarea: `npm run typecheck && npm run lint && npx prettier --check .` más los tests tocados. Todo cambio de `schema.prisma` lleva migración.
- Editar presupuesto = `BUDGET_EDIT`; leerlo = `BUDGET_VIEW`. No se toca `permisosDe`, `accesoAlPresupuesto` ni `EventAccessService.resolve`.
- "Proveedor cobrado" de un gasto: dueño (`vendor_profile.userId`) de su `EventVendor`, con estado `BOOKED` o `CANCELLED`. `SHORTLISTED`, externo (`externalName`) o `payeeName` no cuentan.
- Un proveedor sólo recibe gastos `PAID` que cumplen la regla anterior, nunca `notes`, `category` ni `dueDate`. Fuera de la regla, el error es 404 `VENDOR_PAYMENT_NOT_FOUND`.
- Campana `expense.paid` sólo a un proveedor **BOOKED** cuando su gasto **pasa** a PAID (al crear PAID o al cambiar de PENDING a PAID). Payload `{ expenseId, concept }`, sin importes.
- Overdue = `status = PENDING` y `dueDate < hoy`, donde hoy es la fecha `YYYY-MM-DD` de `now` en `Event.timezone`.
- Upcoming = PENDING con `dueDate >= hoy`, `dueDate` asc y `createdAt` asc de desempate, máximo **5**.
- Factura: `invoiceNumber` de 1 a 60 caracteres tras `trim`. `0 < subtotal <= amount`. Impuestos = `amount − subtotal`, derivado y no guardado.
- Archivo de factura: `image/jpeg`, `image/png`, `image/webp` o `application/pdf`, de 1 byte a 10 MB (`10 * 1024 * 1024`). Prefijo `events/<eventId>/invoices/`. Nombre original de 1 a 200 caracteres.
- Escrituras en `UnidadDeTrabajo` con `clienteDe`. Las campanas se crean dentro de la transacción; jobs y borrados en R2 van después del commit. Un fallo al encolar o al borrar en R2 se registra y no se propaga.

## Contrato (HTTP y socket)

Lo consume el plan del frontend. Rutas de evento con `@UseGuards(JwtAuthGuard, EventAccessGuard)`; rutas `/me` con `JwtAuthGuard`.

| Método y ruta | Acceso | Cuerpo / query | Respuesta |
|---|---|---|---|
| `GET /events/:eventId/expenses` | `BUDGET_VIEW` | lo actual + `q?` (1–100), `status?: PENDING\|PAID\|OVERDUE` | 200 `{ items: GastoJson[], nextCursor }` |
| `POST /events/:eventId/expenses` | `BUDGET_EDIT` | lo actual + `invoiceNumber?`, `subtotal?`, `invoiceFile?: { key, name } \| null` | 201 `GastoJson` |
| `PATCH /events/:eventId/expenses/:expenseId` | `BUDGET_EDIT` | ídem, todos opcionales; `null` quita | 200 `GastoJson` |
| `DELETE /events/:eventId/expenses/:expenseId` | `BUDGET_EDIT` | — | 204 |
| `GET /events/:eventId/budget-summary` | `BUDGET_VIEW` | — | 200 lo actual + `overdue: { amount, count }`, `upcoming: GastoJson[]` |
| `POST /events/:eventId/expenses/invoice-upload-url` | `BUDGET_EDIT` | `{ contentType, bytes }` | 201 `{ key, uploadUrl }` |
| `GET /events/:eventId/expenses/:expenseId/invoice-file` | `BUDGET_VIEW` | — | 200 `{ url }`; 404 `INVOICE_FILE_NOT_FOUND` si el gasto no tiene archivo |
| `GET /me/vendor-payments` | sesión | `eventId?: uuid` | 200 `{ events: PagosDeEventoJson[] }` |
| `GET /me/vendor-payments/:expenseId/invoice-file` | sesión | — | 200 `{ url }`; 404 `VENDOR_PAYMENT_NOT_FOUND` / `INVOICE_FILE_NOT_FOUND` |

```ts
type ArchivoJson = { name: string; contentType: string; bytes: number }
type GastoJson = {
  id; origin; concept; category; amount: string; status: 'PENDING' | 'PAID'
  dueDate: string | null; paidAt: string | null; notes: string | null; createdAt: string
  invoiceNumber: string | null; subtotal: string | null; tax: string | null
  invoiceFile: ArchivoJson | null; overdue: boolean
}
type PagoJson = {
  id: string; concept: string; amount: string; subtotal: string | null; tax: string | null
  invoiceNumber: string | null; paidAt: string; invoiceFile: ArchivoJson | null
}
type PagosDeEventoJson = {
  eventId: string; eventName: string; currency: string; totalReceived: string; payments: PagoJson[]
}
```

- `PagosDeEventoJson[]` va ordenado por el `paidAt` más reciente de cada evento, desc; `payments`, por `paidAt` desc. Un evento sin pagos no aparece.
- Errores nuevos: 422 `INVALID_SUBTOTAL`, 422 `INVALID_INVOICE_FILE`, 409 `INVOICE_NUMBER_TAKEN`, 404 `VENDOR_PAYMENT_NOT_FOUND`, 404 `INVOICE_FILE_NOT_FOUND`. Una key que no es una subida válida de ese evento da 422 `INVALID_UPLOAD` (el existente).
- Socket (namespace `/realtime`), todos con payload `{ eventId }`:
  - `expense.changed` → `user:<id>` de cada usuario con presupuesto (creador y miembros ACTIVE con grant);
  - `vendor-payment.changed` → `user:<id>` de cada proveedor cobrado afectado;
  - `notification.created` (el existente) → a quien se le creó `expense.paid`.

## Review Focus

1. **Gasto que cambia de proveedor estando PAID** (de A a B): A deja de verlo y B empieza a verlo. Los dos reciben `vendor-payment.changed`, y B recibe campana sólo si es BOOKED. → Task 6, test "cambiar de proveedor un gasto pagado avisa a los dos".
2. **Miembro que además es proveedor BOOKED**: `/me/vendor-payments` le devuelve sus pagos aunque `EventAccessService` lo resuelva como `member`. → Task 9, fila del e2e.
3. **PATCH que sólo trae `amount`, por debajo del `subtotal` guardado**: debe ser 422 `INVALID_SUBTOTAL`, no un 500 por el CHECK. → Task 6, test "bajar el importe por debajo del subtotal guardado es 422".
4. **Dos gastos externos con `payeeName` que sólo difieren en mayúsculas y el mismo número**: chocan (409); un gasto sin número nunca choca. → Task 2 (integración) y Task 6 (traducción a 409).
5. **Borrar un gasto con archivo, o reemplazar el archivo**: el objeto anterior se borra de R2 después del commit; si la transacción falla, no se borra nada. → Task 6, test "si la escritura falla no se borra el archivo anterior".

---

### Task 1: Dominio de factura

**Files:**
- Modify: `src/modules/expenses/domain/expense.ts`
- Modify: `src/modules/expenses/domain/expense-errors.ts`
- Test: `src/modules/expenses/domain/expense.test.ts`

**Interfaces:**
- Produces:
  - `interface ArchivoFactura { key: string; name: string; contentType: string; bytes: number }`;
  - `Expense` gana `invoiceNumber: string | null`, `subtotal: string | null`, `invoiceFile: ArchivoFactura | null`;
  - `impuestoDe(amount: string, subtotal: string | null): string | null`;
  - `subtotalValido(amount: string, subtotal: string | null): boolean`;
  - `hoyEnZona(ahora: Date, timezone: string): string` (`YYYY-MM-DD`);
  - `estaVencido(g: { status: ExpenseStatus; dueDate: Date | null }, hoy: string): boolean`;
  - `pasaAPagado(antes: ExpenseStatus | null, despues: ExpenseStatus): boolean` (`antes = null` es un alta);
  - errores `SubtotalInvalidoError` (422 `INVALID_SUBTOTAL`), `NumeroDeFacturaRepetidoError` (409 `INVOICE_NUMBER_TAKEN`), `PagoRecibidoNoEncontradoError` (404 `VENDOR_PAYMENT_NOT_FOUND`), `ArchivoDeFacturaNoEncontradoError` (404 `INVOICE_FILE_NOT_FOUND`).

- [ ] **Step 1: Tests que fallan** en `expense.test.ts`, en un `describe('factura')`:
  - `impuestoDe('121.00', '100.00')` es `'21.00'`; `impuestoDe('100.00', '100.00')` es `'0.00'`; `impuestoDe('100.00', null)` es `null`.
  - `subtotalValido`: `('100.00', '100.00')` true; `('100.00', '100.01')` false; `('100.00', '0.00')` false; `('100.00', null)` true.
  - `hoyEnZona(new Date('2026-11-11T03:00:00Z'), 'America/Caracas')` es `'2026-11-10'`; con `'UTC'` es `'2026-11-11'`.
  - `estaVencido`: PENDING con `dueDate` `2026-11-10` y hoy `'2026-11-11'` es true; con hoy `'2026-11-10'` es false (vence hoy, no está vencido); PAID con fecha pasada es false; sin `dueDate` es false.
  - `pasaAPagado`: `(null,'PAID')` true; `('PENDING','PAID')` true; `('PAID','PAID')` false; `('PAID','PENDING')` false; `(null,'PENDING')` false.
- [ ] **Step 2:** `npx vitest run src/modules/expenses/domain` → FAIL (no existen).
- [ ] **Step 3: Implementar.** Cálculo en céntimos con `aCentimos`/`deCentimos`. `hoyEnZona` con `Intl.DateTimeFormat('en-CA', { timeZone, year, month, day })`, mismo método que `fechaIsoLocal` de `schedule/application/pdf-cronograma.ts`. `estaVencido` compara `dueDate.toISOString().slice(0, 10) < hoy`, porque `dueDate` es `@db.Date` a medianoche UTC.
- [ ] **Step 4:** el mismo comando → PASS.
- [ ] **Step 5: Commit** `feat(expenses): dominio de factura, vencidos e impuestos`.

### Task 2: Esquema, migración y restricciones

**Files:**
- Modify: `prisma/schema.prisma` (modelo `Expense`)
- Create: `prisma/migrations/20261111120000_expense_invoice/migration.sql`
- Modify: `docs/DATABASE.md` (§`expenses`, en inglés como el resto)
- Test: `src/modules/expenses/infrastructure/expenses-restricciones.test.ts`

**Interfaces:**
- Produces: las columnas `invoiceNumber String?`, `subtotal Decimal? @db.Decimal(12, 2)`, `invoiceFileKey String?`, `invoiceFileName String?`, `invoiceFileType String?`, `invoiceFileBytes Int?`. Constraints con estos nombres exactos: `expenses_subtotal_valido`, `expenses_archivo_completo`, `expenses_numero_no_vacio` e índice único `expenses_invoice_number_unique`.

- [ ] **Step 1: Test de integración que falla** (Postgres con `startPostgres()`, insertando con Prisma). Cada caso espera rechazo con el nombre de la constraint en el mensaje:
  - `subtotal` 0 → `expenses_subtotal_valido`; `subtotal` > `amount` → ídem; `subtotal = amount` → OK;
  - sólo `invoiceFileKey` sin las otras tres → `expenses_archivo_completo`; las cuatro → OK;
  - `invoiceNumber` `'   '` → `expenses_numero_no_vacio`;
  - mismo `eventVendorId` y mismo número en el mismo evento → `expenses_invoice_number_unique`; mismo número con otro `eventVendorId`, o en otro evento → OK;
  - `payeeName` `'Ana'` y `'ANA'` con el mismo número → `expenses_invoice_number_unique`;
  - dos gastos sin número del mismo proveedor → OK.
- [ ] **Step 2:** `npx vitest run src/modules/expenses/infrastructure/expenses-restricciones.test.ts` → FAIL.
- [ ] **Step 3: Esquema y migración.** Las columnas van con `npx prisma migrate dev --create-only --name expense_invoice`; después se renombra la carpeta a `20261111120000_expense_invoice` y se añade a mano:
  ```sql
  ALTER TABLE "expenses" ADD CONSTRAINT "expenses_subtotal_valido"
    CHECK ("subtotal" IS NULL OR ("subtotal" > 0 AND "subtotal" <= "amount"));
  ALTER TABLE "expenses" ADD CONSTRAINT "expenses_archivo_completo" CHECK (
    ("invoiceFileKey" IS NULL AND "invoiceFileName" IS NULL AND "invoiceFileType" IS NULL AND "invoiceFileBytes" IS NULL)
    OR ("invoiceFileKey" IS NOT NULL AND "invoiceFileName" IS NOT NULL AND "invoiceFileType" IS NOT NULL AND "invoiceFileBytes" IS NOT NULL));
  ALTER TABLE "expenses" ADD CONSTRAINT "expenses_numero_no_vacio"
    CHECK ("invoiceNumber" IS NULL OR length(btrim("invoiceNumber")) > 0);
  CREATE UNIQUE INDEX "expenses_invoice_number_unique" ON "expenses"
    ("eventId", COALESCE("eventVendorId"::text, lower("payeeName")), "invoiceNumber")
    WHERE "invoiceNumber" IS NOT NULL;
  ```
  El índice no se declara en `schema.prisma`, porque Prisma no expresa índices por expresión; lo dice un comentario `///` sobre el modelo. Comprobar que `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url …` sale vacío, igual que en CI. Documentar en `DATABASE.md` las columnas, los tres CHECK y el UNIQUE, y que el caso de uso valida que el archivo existe en R2 y que el subtotal no supera el importe al cambiar sólo uno de los dos.
- [ ] **Step 4:** el test → PASS; `npx prisma validate`.
- [ ] **Step 5: Commit** `feat(expenses): columnas de factura con CHECK y UNIQUE`.

### Task 3: Subida de archivos de factura (storage)

**Files:**
- Create: `src/modules/storage/domain/archivo-de-factura.ts`
- Create: `src/modules/storage/application/subida-directa.ts`
- Modify: `src/modules/storage/application/subida-de-imagenes.ts` (pasa a usar `SubidaDirecta`, sin cambiar su API pública)
- Create: `src/modules/storage/application/subida-de-facturas.ts`
- Modify: `src/modules/storage/application/object-storage.port.ts`, `infrastructure/r2-object-storage.ts`, `infrastructure/object-storage.fake.ts`, `infrastructure/sin-almacenamiento.ts`, `storage.module.ts` (exporta `SubidaDeFacturas`)
- Test: `src/modules/storage/application/subida-de-facturas.test.ts` (y que `subida-de-imagenes.test.ts` siga en verde sin cambios)

**Interfaces:**
- Produces:
  - `ObjectStorage.firmarLectura(key: string, descargarComo?: string | undefined): Promise<string | null>`. Con `descargarComo`, R2 firma `ResponseContentDisposition: attachment; filename*=UTF-8''<encodeURIComponent(nombre)>`. El fake añade `?as=<nombre>` a la URL.
  - `TIPOS_DE_FACTURA = { 'image/jpeg','image/png','image/webp','application/pdf' }` y `MAX_BYTES_FACTURA = 10 * 1024 * 1024`; `ArchivoDeFacturaInvalidoError` (422 `INVALID_INVOICE_FILE`).
  - `SubidaDeFacturas` (`@Injectable`):
    - `preparar(prefijo: string, contentType: string, bytes: number): Promise<SubidaPreparada>`;
    - `confirmar(prefijo: string, key: string): Promise<{ contentType: string; bytes: number }>`;
    - `firmarLectura(key: string, nombre: string): Promise<string | null>`;
    - `borrar(key: string): Promise<void>`.
  - `SubidaDirecta`: clase sin decorador, parametrizada por `{ extension(contentType): string | null; valida(contentType, bytes): boolean; errorDeTipo: () => DomainError }`. Concentra preparar, confirmar y borrar, que hoy tiene `SubidaDeImagenes`. Así se generaliza sin duplicar (spec §7).

- [ ] **Step 1: Tests que fallan** (contra `ObjectStorageEnMemoria`):
  - `preparar` de `application/pdf` de 2 MB devuelve una key `events/E/invoices/<uuid>.pdf`;
  - `preparar` de `text/plain` o de 10 MB + 1 lanza `ArchivoDeFacturaInvalidoError`;
  - `confirmar` de una key subida como PDF de 1024 bytes devuelve `{ contentType: 'application/pdf', bytes: 1024 }`;
  - `confirmar` con prefijo ajeno lanza `SubidaNoValidaError`;
  - `confirmar` de un objeto `text/html` lanza `SubidaNoValidaError` y lo borra (queda en `borradas`);
  - sin almacenamiento (`disponible = false`), `preparar` lanza `AlmacenamientoNoDisponibleError`;
  - `firmarLectura(key, 'factura 1.pdf')` contiene `as=factura%201.pdf`.
- [ ] **Step 2:** `npx vitest run src/modules/storage` → FAIL.
- [ ] **Step 3: Implementar**, con `SubidaDeImagenes` reescrita sobre `SubidaDirecta` y sus tests sin tocar.
- [ ] **Step 4:** `npx vitest run src/modules/storage src/modules/moodboard src/modules/users src/modules/vendors` → PASS.
- [ ] **Step 5: Commit** `feat(storage): subida directa de archivos de factura (PDF e imágenes)`.

### Task 4: Puerto y repositorios de gastos (paridad)

**Files:**
- Modify: `src/modules/expenses/application/expense.repository.ts`
- Modify: `src/modules/expenses/infrastructure/prisma-expense.repository.ts`
- Modify: `src/modules/expenses/infrastructure/expense.repository.fake.ts`
- Test: `src/modules/expenses/infrastructure/expense.repository.paridad.test.ts`

**Interfaces:**
- Consumes: `ArchivoFactura`, `NumeroDeFacturaRepetidoError` (Task 1); las columnas (Task 2).
- Produces:
  - `DatosNuevoGasto` gana `invoiceNumber: string | null`, `subtotal: string | null`, `invoiceFile: ArchivoFactura | null`; `CambiosGasto` gana los tres como `?: X | null | undefined`.
  - `FiltroGastos` pasa a `{ status: 'PENDING' | 'PAID' | 'OVERDUE' | null; origin; eventVendorId; q: string | null; hoy: string }`.
  - `vencidos(eventId: string, hoy: string): Promise<{ amount: string; count: number }>`.
  - `proximos(eventId: string, hoy: string, limit: number): Promise<Expense[]>`.
  - `proveedorCobrable(eventVendorId: string): Promise<{ userId: string; status: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED' } | null>`: `null` si el `EventVendor` no tiene ficha.
  - `listarPagosRecibidos(userId: string, eventId: string | null): Promise<PagoRecibido[]>`.
  - `buscarPagoRecibido(userId: string, expenseId: string): Promise<PagoRecibido | null>`.
  - `PagoRecibido` (exportado del puerto) `{ expenseId; eventId; eventName; currency; concept; amount; subtotal: string | null; invoiceNumber: string | null; paidAt: Date; invoiceFile: ArchivoFactura | null }`.
  - `crear` y `actualizar` traducen la violación de `expenses_invoice_number_unique` (Prisma `P2002`, o `23505` en `meta`) a `NumeroDeFacturaRepetidoError`.
  - Fake: `ProveedorEnMemoria` gana `userId: string | null`; el fake gana `eventos: { id: string; name: string; currency: string }[]`.

- [ ] **Step 1: Casos de paridad que fallan.** Mismo patrón que los existentes: `sujetos()` y `sinVolatiles`. `sembrarEvento` acepta `status: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'` y un `userId` opcional; con él crea `VendorProfile` y enlaza `vendorProfileId` en Postgres.
  - crear y releer con `invoiceNumber`, `subtotal` e `invoiceFile`, y `actualizar` a `null` los tres;
  - `q`: `'dj'` encuentra por nombre de proveedor, `'anticipo'` por concepto, `'F-0'` por número, `'ana'` por `payeeName`, y no distingue mayúsculas;
  - `status: 'OVERDUE'` con `hoy` devuelve sólo PENDING con `dueDate < hoy`;
  - `vencidos` suma y cuenta lo mismo que el filtro;
  - `proximos` con 7 candidatos devuelve 5 en orden `dueDate` asc, excluye los vencidos, los PAID y los que no tienen fecha;
  - `listarPagosRecibidos(user)` incluye PAID de BOOKED y de CANCELLED, y excluye PENDING, SHORTLISTED y los de otro usuario; con `eventId` filtra; orden `paidAt` desc;
  - `buscarPagoRecibido` devuelve `null` en esos mismos casos excluidos;
  - `proveedorCobrable` de un externo es `null`;
  - número repetido del mismo proveedor lanza `NumeroDeFacturaRepetidoError` en los dos sujetos.
- [ ] **Step 2:** `npx vitest run src/modules/expenses/infrastructure` → FAIL.
- [ ] **Step 3: Implementar** los dos adaptadores.
  - `q` en Prisma: `OR` de `contains` con `mode: 'insensitive'` sobre `concept`, `payeeName`, `invoiceNumber`, `eventVendor.externalName` y `eventVendor.vendorProfile.businessName`.
  - El fake replica el UNIQUE con `lower(payeeName)`.
- [ ] **Step 4:** el mismo comando → PASS.
- [ ] **Step 5: Commit** `feat(expenses): puerto con factura, búsqueda, vencidos y pagos recibidos`.

### Task 5: Quién tiene presupuesto (events)

**Files:**
- Modify: `src/modules/events/application/event-access.service.ts`
- Test: `src/modules/events/application/event-access.service.test.ts` (crear si no existe, contra `event.repository.fake.ts`)

**Interfaces:**
- Produces: `EventAccessService.usuariosConPresupuesto(eventId: string): Promise<string[]>`. Devuelve los `userId` de los miembros **ACTIVE** de `listarMiembros` para los que `accesoAlPresupuesto({ kind: 'member', role, owner, budgetView }) !== 'none'`. Así la regla sigue en un solo sitio y el worker de `expenses` no la duplica.

- [ ] **Step 1: Test que falla:** con creador, miembro ACTIVE con grant, miembro ACTIVE sin grant y miembro INVITED con grant, devuelve `[creador, conGrant]` en cualquier orden.
- [ ] **Step 2:** `npx vitest run src/modules/events/application` → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(events): usuarios con acceso al presupuesto de un evento`.

### Task 6: Casos de uso de escritura con factura y avisos

**Files:**
- Create: `src/modules/expenses/application/avisos-gastos.ts`
- Modify: `create-expense.use-case.ts`, `update-expense.use-case.ts`, `delete-expense.use-case.ts` (en `expenses/application/`)
- Create: `src/modules/expenses/application/archivos-de-factura.use-cases.ts`
- Modify: `src/modules/queue/application/queue.port.ts` (`QueueName` += `'expenses'`, y su docblock)
- Modify: `src/modules/notifications/application/notification.port.ts` (`TIPO_GASTO_PAGADO = 'expense.paid'`, dentro de `TIPOS_PARA_PROVEEDOR`)
- Test: `src/modules/expenses/application/expenses.use-cases.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3 y 4; `NOTIFICATION_PORT.crearParaUsuarios`, `QUEUE_PORT`, `UNIDAD_DE_TRABAJO`.
- Produces:
  - `COLA_GASTOS = 'expenses'`, `EVENTO_GASTO_CAMBIADO = 'expense.changed'`, `EVENTO_PAGO_PROVEEDOR_CAMBIADO = 'vendor-payment.changed'`;
  - `interface JobGastoCambiado { eventId: string; proveedoresA: string[]; campanaA: string[] }`, con un único nombre de job `EVENTO_GASTO_CAMBIADO`;
  - `encolarAvisoGasto(cola, registro, job)` con jobId `expense-<expenseId>-<marcaCreciente>`, mismo patrón que `jobIdDeImagen`;
  - `EntradaGasto` gana `invoiceNumber?`, `subtotal?` y `invoiceFile?: { key: string; name: string } | null`;
  - `PrepararSubidaFacturaUseCase.ejecutar(eventId, contentType, bytes): Promise<SubidaPreparada>`;
  - `ArchivoDeGastoUseCase.ejecutar(eventId, expenseId): Promise<{ url: string }>`: lanza `GastoNoEncontradoError`, `ArchivoDeFacturaNoEncontradoError`, o 503 sin R2.

Reglas que fija esta tarea:
- `invoiceFile: { key, name }` → `SubidaDeFacturas.confirmar('events/<eventId>/invoices', key)`, **antes** de abrir la transacción. Guarda `{ key, name, contentType, bytes }` con lo que dice R2.
- Subtotal: se valida `subtotalValido(amountFinal, subtotalFinal)` con los valores finales (lo que llega o, si no llega, lo guardado). Si no cumple, `SubtotalInvalidoError`.
- Dentro de la transacción:
  - se relee el gasto (`buscarPorId`) y se escribe;
  - destinatarios: los proveedores cobrables (`proveedorCobrable`, BOOKED o CANCELLED) del `eventVendorId` de **antes** si estaba PAID y del de **después** si queda PAID, sin repetir, en `proveedoresA`;
  - si `pasaAPagado(antes, después)` o el gasto cambia de proveedor estando PAID, y el proveedor de después es **BOOKED**: `crearParaUsuarios(eventId, [userId], TIPO_GASTO_PAGADO, { expenseId, concept })` y ese userId va a `campanaA`.
- Después del commit: `encolarAvisoGasto` siempre, porque `expense.changed` le interesa a quien ve el presupuesto. Después, `SubidaDeFacturas.borrar(keyAnterior)` si el archivo se reemplazó o se quitó, o si se borró el gasto.

- [ ] **Step 1: Tests que fallan** (fakes: repositorio, `ObjectStorageEnMemoria`, notificaciones, cola y unidad de trabajo, como en `moodboard.use-cases.test.ts`):
  - "crear PAID a un proveedor BOOKED crea la campana y encola con `campanaA` y `proveedoresA`";
  - "crear PENDING no crea campana; encola con listas vacías";
  - "pasar a PAID a un CANCELLED no crea campana pero sí lo pone en `proveedoresA`";
  - "pasar a PAID a un SHORTLISTED o a un externo no avisa a nadie";
  - "editar un gasto ya PAID no crea campana y sí avisa al proveedor";
  - "volver a PENDING y borrar un PAID avisan al proveedor sin campana";
  - "cambiar de proveedor un gasto pagado avisa a los dos" (Review Focus 1);
  - "bajar el importe por debajo del subtotal guardado es 422" (Review Focus 3);
  - "una key de otro evento es `INVALID_UPLOAD`";
  - "reemplazar el archivo borra el anterior tras el commit";
  - "si la escritura falla no se borra el archivo anterior" (Review Focus 5: el repositorio lanza `NumeroDeFacturaRepetidoError` → no hay `borradas` y el error se propaga como 409);
  - "un fallo al encolar no rompe la escritura";
  - "`ArchivoDeGastoUseCase` firma con el nombre original; sin archivo da `INVOICE_FILE_NOT_FOUND`".
- [ ] **Step 2:** `npx vitest run src/modules/expenses/application` → FAIL.
- [ ] **Step 3: Implementar.** Los docblocks citan spec §8 y §9, y dicen por qué la campana sólo va a BOOKED: `visiblesDe` la escondería a un CANCELLED, y lo descartado sería avisar a quien no la verá.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(expenses): factura con archivo, campana expense.paid y avisos en cola propia`.

### Task 7: Casos de uso de lectura

**Files:**
- Modify: `src/modules/expenses/application/list-expenses.use-case.ts`, `budget-summary.use-case.ts`
- Create: `src/modules/expenses/application/pagos-recibidos.use-cases.ts`
- Modify: `src/modules/expenses/domain/expense.ts` (`ResumenPresupuesto` gana `overdue` y `upcoming`)
- Test: `src/modules/expenses/application/expenses.use-cases.test.ts`

**Interfaces:**
- Consumes: Task 4; `EVENT_REPOSITORY.buscarPorId` (por `timezone`).
- Produces:
  - `ListExpensesUseCase.ejecutar(eventId, filtro: Omit<FiltroGastos, 'hoy'>, cursor, limit)`: calcula `hoy` con `hoyEnZona(new Date(), evento.timezone)`.
  - `GastoListado = Expense & { overdue: boolean }`, devuelto por el listado y por `upcoming`. Esta tarea también cambia el retorno de `CreateExpenseUseCase`/`UpdateExpenseUseCase` (Task 6) a `GastoListado`: calculan `overdue` con el mismo `hoy`, leyendo el evento.
  - `ResumenPresupuesto` += `overdue: { amount: string; count: number }`, `upcoming: GastoListado[]`.
  - `PagosRecibidosUseCase`:
    - `listar(userId: string, eventId: string | null): Promise<PagosDeEvento[]>`, con `PagosDeEvento = { eventId; eventName; currency; totalReceived: string; payments: PagoRecibido[] }`, agrupado y ordenado como dice la §Contrato;
    - `archivo(userId: string, expenseId: string): Promise<{ url: string }>`.
  - Inyectar un reloj (`() => Date`, provider `RELOJ` si ya existe uno en `shared`; si no, parámetro opcional del constructor) para que los tests fijen "hoy".

- [ ] **Step 1: Tests que fallan:**
  - con evento en `America/Caracas` y reloj `2026-11-11T03:00:00Z`, un PENDING con `dueDate` `2026-11-10` **no** sale vencido (allí aún es día 10) y uno de `2026-11-09` sí;
  - resumen con `overdue` y con `upcoming` de 5;
  - `listar` agrupa dos eventos, suma `totalReceived` por evento y ordena;
  - `archivo` de un pago ajeno da `VENDOR_PAYMENT_NOT_FOUND`; de un pago propio sin archivo, `INVOICE_FILE_NOT_FOUND`.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(expenses): vencidos, próximos pagos y pagos recibidos del proveedor`.

### Task 8: Worker, controladores, DTO y módulo

**Files:**
- Create: `src/modules/expenses/interfaces/expenses.processor.ts` (+ `expenses.processor.test.ts`)
- Modify: `src/modules/expenses/interfaces/expenses.controller.ts`, `expenses.dto.ts` (+ `expenses.dto.test.ts`)
- Create: `src/modules/expenses/interfaces/vendor-payments.controller.ts`
- Create: `src/modules/expenses/interfaces/expenses.json.ts` (`aGastoJson`, `aPagoJson`, `aPagosDeEventoJson`, sacados del controlador)
- Modify: `src/modules/expenses/expenses.module.ts`

**Interfaces:**
- Consumes: Tasks 5, 6 y 7; `REALTIME_PORT`, `NOTIFICACION_CREADA`.
- Produces: las rutas y JSON de la §Contrato.
  - `ExpensesModule` importa `NotificationsModule`, `StorageModule` y `BullModule.registerQueue({ name: COLA_GASTOS })`, igual que `MoodboardModule`.
  - `GastosProcessor` (`@Processor(COLA_GASTOS)`): valida el job con zod (`satisfies z.ZodType<JobGastoCambiado>`) y emite `expense.changed` a `usuariosConPresupuesto(eventId)` releído en ese momento, `vendor-payment.changed` a `proveedoresA` y `NOTIFICACION_CREADA` a `campanaA`. Un nombre de job desconocido o un payload roto lanzan `UnrecoverableError`.

DTO:
- `invoiceNumber: z.string().trim().min(1).max(60).nullable().optional()`;
- `subtotal: montoPositivo.nullable().optional()`;
- `invoiceFile: z.object({ key: z.string().min(1).max(300), name: z.string().trim().min(1).max(200) }).strict().nullable().optional()`;
- listado: `q: z.string().trim().min(1).max(100).optional()` y `status` con `'OVERDUE'`;
- `uploadUrlSchema` igual que el de moodboard;
- `/me/vendor-payments`: `eventId: z.uuid().optional()`.

`vendor-payments.controller.ts`: `@UseGuards(JwtAuthGuard) @Controller('me/vendor-payments')`, con `exigirUsuario` y `idDeRuta(expenseId, () => new PagoRecibidoNoEncontradoError())`.

- [ ] **Step 1: Tests que fallan:**
  - DTO: `invoiceNumber` vacío, 61 caracteres, `subtotal` `'0.00'`, `invoiceFile` sin `name`, `status=OVERDUE` válido, `q` de 101 → mensajes de `validarCon`;
  - processor: emite a los usuarios releídos (no a una lista del job) y rechaza un payload roto.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS, y además `npm run lint:arch` en verde: `expenses` sólo importa `application/` de `storage`, `notifications`, `queue` y `events`.
- [ ] **Step 5: Commit** `feat(expenses): rutas de factura, pagos recibidos y worker de avisos`.

### Task 9: E2E de la matriz de acceso y avisos

**Files:**
- Create: `test/e2e/facturas.e2e.test.ts`

**Interfaces:**
- Consumes: la app entera vía `arrancarAppDeTest()`. Escenario como en `budget-visibility.e2e.test.ts`:
  - Ana, creadora;
  - Lia, COUPLE con grant;
  - Luis, COUPLE sin grant;
  - DJ, proveedor BOOKED con ficha;
  - Flor, otra proveedora BOOKED con ficha;
  - Marta, proveedora con ficha y contratación CANCELLED tras pagarle;
  - Sara, SHORTLISTED con ficha;
  - Pía, PLANNER invitada que además es proveedora BOOKED con ficha;
  - un extraño.
  - Gastos: PAID y PENDING de DJ, PAID de Flor, PAID de Marta, PAID de Sara, PAID de Pía. Sin R2, el archivo se siembra escribiendo las columnas con Prisma, y la descarga se prueba con R2 ausente → 503 `STORAGE_UNAVAILABLE`.

- [ ] **Step 1: Escribir los casos:**
  - **Ana**: lista, resumen (`overdue`, `upcoming`), crea con `invoiceNumber` y `subtotal` (201 con `tax`), número repetido → 409 `INVOICE_NUMBER_TAKEN`, `subtotal` > `amount` → 422, `invoice-upload-url` → 503 sin R2, `invoice-file` de un gasto sin archivo → 404 `INVOICE_FILE_NOT_FOUND`.
  - **Lia**: lee lista, resumen e `invoice-file`; escribir y `invoice-upload-url` → 403.
  - **Luis**: 403 en las rutas de evento; `/me/vendor-payments` → `{ events: [] }`.
  - **DJ**: rutas de evento de gastos → 403; `/me/vendor-payments` devuelve **sólo** su PAID (ni el PENDING, ni el de Flor), con `invoiceNumber` y sin `notes`, `category` ni `dueDate` (comprobar las claves exactas); `/me/vendor-payments/<gastoDeFlor>/invoice-file` → 404 `VENDOR_PAYMENT_NOT_FOUND`.
  - **Marta (CANCELLED)**: `/me/vendor-payments` devuelve su pago; `GET /events/:id` y `GET /events/:id/expenses` → 404.
  - **Sara (SHORTLISTED)**: `{ events: [] }`.
  - **Pía**: `/me/vendor-payments` devuelve su pago (Review Focus 2); las rutas de evento de gastos le dan 403 porque no tiene grant.
  - **Extraño**: 404 en todas las rutas de evento; `{ events: [] }`.
  - **Avisos**: con un cliente Socket.IO de DJ y otro de Lia conectados (mismo patrón que `moodboard.e2e.test.ts`), Ana pasa a PAID un PENDING de DJ. DJ recibe `vendor-payment.changed` y `notification.created`, y su campana (`GET /notifications`) tiene un `expense.paid`; Lia recibe `expense.changed`; Luis no recibe nada.
- [ ] **Step 2:** `npx vitest run test/e2e/facturas.e2e.test.ts` → PASS. Si algo falla, se arregla en la tarea que posee el código, no en el test.
- [ ] **Step 3:** suite completa `npm test`, `npm run build && npm run test:smoke`, `npm run typecheck && npm run lint && npx prettier --check .` → todo en verde.
- [ ] **Step 4: Commit** `test(expenses): e2e de facturas — matriz de acceso y avisos`.
