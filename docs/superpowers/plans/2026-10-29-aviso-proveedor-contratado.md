# Aviso al proveedor contratado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando el dueño del evento pasa una contratación a `BOOKED`, el proveedor (con cuenta) recibe `event.vendor.booked` en la campana, en tiempo real, y puede marcarlo leído.

**Architecture:** La visibilidad de `/me/notifications` se amplía a eventos donde el usuario es proveedor `BOOKED`; el `PATCH` de la contratación detecta la transición con una escritura condicionada dentro de su transacción y crea/reaviva la fila con un método nuevo de `NotificationPort`; el aviso de socket va por la cola `notifications`. El frontend sólo añade el texto del tipo.

**Tech Stack:** NestJS 11, Prisma 6/Postgres 16, BullMQ, Zod, Vitest + Testcontainers; React 19 + zod en el frontend.

**Spec:** `docs/superpowers/specs/2026-10-29-aviso-proveedor-contratado-design.md` (amplía `2026-10-21-notificaciones-design.md`).

## Global Constraints

- Backend: rama `feat/aviso-proveedor-contratado` (ya creada desde `develop`). Frontend: rama `feat/aviso-proveedor-contratado` desde `develop`. Sin push ni PR (lo decide el usuario al final).
- Comentarios, docblocks y `describe`/`it` en español; strings de API y textos de UI en inglés. Prettier: sin `;`, comillas simples, ancho 100.
- Gate backend: `npm run typecheck && npm run lint && npx prettier --check .` + tests tocados; `npm test` antes del commit final de cada tarea. Gate frontend: `npm run typecheck && npm run lint && npm run format:check`.
- Tipo `event.vendor.booked`; payload `{ eventVendorId: string }`; texto `"You were booked for {event.name}"`; destino `/events/:id/dashboard`.
- Destinatario: SÓLO el `userId` de la `VendorProfile` de la contratación; contratación externa (sin `vendorProfileId`) → ningún aviso. Pareja y planners nunca.
- Una fila por contratación: volver a `BOOKED` reaviva la fila de ese `eventVendorId` (`readAt = null`, `createdAt = now`), no crea otra.
- Transición = la escritura condicionada `status <> 'BOOKED'` afectó una fila. `BOOKED → BOOKED` o `PATCH` sin `status` no avisan.
- La fila se escribe en la misma transacción que el cambio de estado (`enTransaccion` + `clienteDe`). Encolar va después del commit; si falla, `warn` y se traga.
- Visibilidad: membresía ACTIVE **o** `EventVendor` del evento `BOOKED` cuya `VendorProfile.userId` es el usuario.
- No cambiar el contrato de `notification.created` (`{ eventId, type }`) ni el de `/me/notifications`. No borrar `DESIGN-GAP`.

## Review Focus

1. Proveedor contratado y luego cancelado: el aviso desaparece de la lista y del contador, y `read-all` no lo toca (Task 1, paridad).
2. Dos `PATCH status: BOOKED` seguidos → una sola fila (Task 2, integración Postgres).
3. `BOOKED → CANCELLED → BOOKED` → una fila, sin leer, con `createdAt` posterior (Task 2).
4. Un usuario que es a la vez miembro ACTIVE y proveedor del evento: sus avisos de miembro siguen igual y no se duplican (Task 1, paridad).
5. Proveedor marca su aviso leído por la ruta por evento → 204, no 403 (Task 1, e2e).

---

### Task 1: Visibilidad para proveedores, `avisarAProveedor` y marcar leída como `VENDOR`

**Files:**
- Modify: `src/modules/notifications/infrastructure/prisma-notification.repository.ts` (`visiblesDe`, nuevo método)
- Modify: `src/modules/notifications/infrastructure/notification.repository.fake.ts`, `notification.port.fake.ts`
- Modify: `src/modules/notifications/application/notification.port.ts`, `notification.repository.ts` (docblock de visibilidad)
- Modify: `src/modules/notifications/interfaces/notifications.controller.ts` (`marcarLeida`: `@RequireEventAccess('COUPLE', 'PLANNER', 'VENDOR')`)
- Test: `notification.repository.paridad.test.ts`, `test/e2e/my-notifications.e2e.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // NotificationPort
  /** Crea `event.vendor.booked` para `userId` o reaviva la de ese `eventVendorId`. */
  avisarAProveedor(eventId: string, userId: string, eventVendorId: string): Promise<void>
  // tipo exportado desde notifications/domain/notification.ts
  export const TIPO_PROVEEDOR_CONTRATADO = 'event.vendor.booked'
  // dobles
  NotificationRepositoryEnMemoria.registrarProveedorContratado(eventId: string, userId: string): void
  NotificationRepositoryEnMemoria.quitarProveedorContratado(eventId: string, userId: string): void
  ```
  Prisma: `visiblesDe(userId)` pasa a `{ userId, event: { OR: [ { memberships: { some: { userId, status: 'ACTIVE' } } }, { vendors: { some: { status: 'BOOKED', vendorProfile: { userId } } } } ] } }` (ajustar a los nombres de relación reales del schema). `avisarAProveedor` con `clienteDe`: `updateMany` sobre `{ eventId, userId, type: TIPO_PROVEEDOR_CONTRATADO, payload: { path: ['eventVendorId'], equals: eventVendorId } }` → `{ readAt: null, createdAt: new Date() }`; si afectó 0 filas, `create`. Docblock: correspondencia `event.vendor.booked → VENDOR → /events/:id/dashboard → sólo el proveedor` y por qué reaviva (spec §3).

- [ ] **Step 1: Paridad (falla)** — nuevos `it` en el fichero de paridad:
  - `it('un proveedor BOOKED ve y cuenta su aviso; si lo cancelan, ni lo ve ni lo cuenta')`
  - `it('read-all de un proveedor no toca avisos de contrataciones canceladas')`
  - `it('miembro y proveedor a la vez: sus avisos de miembro siguen igual y no se duplican')`
  - `it('avisarAProveedor crea una fila y, llamado otra vez para la misma contratación, la reaviva sin crear otra')` — tras marcarla leída, la segunda llamada deja `readAt === null`, `createdAt` mayor, `length === 1`.
- [ ] **Step 2:** `npx vitest run src/modules/notifications/infrastructure/notification.repository.paridad.test.ts` → FAIL.
- [ ] **Step 3:** Implementar en Prisma y dobles; actualizar el docblock de `listarDeUsuario` ("ACTIVE hoy" → "ACTIVE o proveedor BOOKED hoy").
- [ ] **Step 4:** Step 2 → PASS.
- [ ] **Step 5: E2E** en `my-notifications.e2e.test.ts` (filas y contratación sembradas con Prisma): `it('un proveedor contratado ve su aviso con el nombre del evento y lo marca leído (204)')`, `it('al cancelar su contratación el aviso desaparece del listado y del contador')`. Correr → PASS.
- [ ] **Step 6:** `npm test` + gate.
- [ ] **Step 7: Commit** `feat(notifications): los proveedores contratados ven y marcan sus avisos`

---

### Task 2: El `PATCH` a `BOOKED` avisa al proveedor

**Files:**
- Modify: `src/modules/vendors/application/event-vendor.repository.ts` (resultado de `actualizar`)
- Modify: `src/modules/vendors/infrastructure/prisma-event-vendor.repository.ts`, `event-vendor.repository.fake.ts`
- Modify: `src/modules/vendors/application/update-event-vendor.use-case.ts`
- Create: `src/modules/vendors/application/aviso-proveedor-contratado.ts`
- Modify: `src/modules/vendors/interfaces/event-vendors.controller.ts` (usa `resultado.vista`)
- Modify: `src/modules/vendors/vendors.module.ts` (importa `NotificationWriterModule`; `QUEUE_PORT` si no está)
- Modify: `src/modules/notifications/interfaces/notification.processor.ts` (nuevo `case`)
- Test: `src/modules/vendors/application/update-event-vendor.use-case.test.ts`, test de integración del repo Prisma de event-vendors (crearlo junto al adaptador si no existe), `src/modules/vendors/infrastructure/update-event-vendor.atomicidad.test.ts`, `notification.processor.test.ts`, `test/e2e/event-vendors.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1 (`avisarAProveedor`, `TIPO_PROVEEDOR_CONTRATADO`), `enTransaccion` (`database/transaccion.ts`), `UNIDAD_DE_TRABAJO`.
- Produces:
  ```ts
  // event-vendor.repository.ts
  export interface ResultadoActualizacion {
    vista: EventVendorVista
    /** Sólo si ESTA escritura pasó el estado a BOOKED (escritura condicionada). */
    contratado: { proveedorUserId: string | null } | null
  }
  actualizar(eventId, eventVendorId, cambios, actorUserId): Promise<ResultadoActualizacion>
  // aviso-proveedor-contratado.ts
  export interface JobProveedorContratado { eventId: string; userId: string }
  export function jobIdDeProveedorContratado(eventVendorId: string, en: Date): string // `vendor-booked-${eventVendorId}-${ms}`
  export async function encolarAvisoProveedor(cola: QueuePort, registro: Logger, job: JobProveedorContratado, eventVendorId: string): Promise<void>
  ```
  Prisma `actualizar` con `enTransaccion(this.prisma, …)`: los campos que no son `status` como hoy; si `cambios.status === 'BOOKED'`, `updateMany({ where: { id, eventId, status: { not: 'BOOKED' } }, data: { status: 'BOOKED' } })` y `contratado` sólo si `count === 1`, con `proveedorUserId` leído de `vendorProfile.userId` en la relectura (null si externa); otro `status` se escribe sin condición. El `AuditLog` no cambia.
  Caso de uso: inyecta además `NOTIFICATION_PORT`, `UNIDAD_DE_TRABAJO`, `QUEUE_PORT`. `unidadDeTrabajo.ejecutar(async () => { const r = await actualizar(...); if (r.contratado?.proveedorUserId) await notificaciones.avisarAProveedor(eventId, userId, eventVendorId); return r })`; tras el commit, si avisó, `encolarAvisoProveedor`. Devuelve `EventVendorVista`.
  Worker: `case TIPO_PROVEEDOR_CONTRATADO` valida `{ eventId: z.guid(), userId: z.guid() }` (`satisfies z.ZodType<JobProveedorContratado>`) → `avisos.avisarAUsuario(userId, NOTIFICACION_CREADA, { eventId, type: TIPO_PROVEEDOR_CONTRATADO })`.

- [ ] **Step 1: Unitarios (fallan)** en `update-event-vendor.use-case.test.ts`:
  - `it('pasar a BOOKED avisa al proveedor de la contratación')` → `avisarAProveedor` con `(eventId, userIdProveedor, eventVendorId)` y un job encolado.
  - `it('BOOKED → BOOKED no vuelve a avisar')`; `it('un PATCH sin status no avisa')`; `it('una contratación externa pasa a BOOKED sin avisar a nadie')`.
  - `it('si avisar falla, el PATCH falla y no se encola nada')` (`fallarProximaCreacion` o equivalente del doble).
  - `it('si encolar falla, el PATCH responde igual')`.
- [ ] **Step 2:** Correr → FAIL.
- [ ] **Step 3:** Implementar repo (Prisma + doble), caso de uso, contrato del job, controlador y módulo. `npm run lint:arch` sin ciclos.
- [ ] **Step 4:** Step 2 → PASS.
- [ ] **Step 5: Integración y atomicidad (Postgres real):**
  - `it('dos PATCH a BOOKED seguidos: sólo el primero informa la transición')` (repo Prisma).
  - `it('si crear el aviso falla, la contratación sigue en SHORTLISTED')` (caso de uso con repo Prisma, `PrismaUnidadDeTrabajo` y el doble de notificaciones fallando; modelo: `src/modules/guests/infrastructure/handle-delivery-event.atomicidad.test.ts`).
- [ ] **Step 6: Worker** — `it('event.vendor.booked avisa sólo al proveedor en su sala personal')`, `it('un job de proveedor con payload roto es irrecuperable')`.
- [ ] **Step 7: E2E** en `event-vendors.e2e.test.ts` (dueño, planner y un proveedor con cuenta y ficha):
  - `it('el dueño contrata y el proveedor ve "event.vendor.booked" en /me/notifications; la pareja y el planner no')`.
  - `it('cancelar y volver a contratar deja un solo aviso, sin leer')`.
  Correr → PASS.
- [ ] **Step 8:** `npm test`, gate, `npm run build && npm run test:smoke`.
- [ ] **Step 9: Commit** `feat(vendors): contratar a un proveedor le avisa en la campana`

---

### Task 3: Texto del aviso en el frontend

**Files:**
- Modify: `src/features/notifications/notifications-model.ts`
- Test: `src/features/notifications/notifications-model.test.ts`

**Interfaces:**
- Produces: `describeNotification` reconoce `event.vendor.booked` con payload `{ eventVendorId: string }` → `{ text: \`You were booked for ${event.name}\`, href: \`${base}/dashboard\` }`.

- [ ] **Step 1 (en el repo frontend):** `git checkout -b feat/aviso-proveedor-contratado develop`.
- [ ] **Step 2: Test (falla):** añadir al `it.each` existente `['event.vendor.booked', { eventVendorId: 'ev-v-1' }, 'You were booked for Boda', '/events/ev%201/dashboard']`, y `it('event.vendor.booked con payload roto es genérico')`.
- [ ] **Step 3:** `npx vitest run src/features/notifications/notifications-model.test.ts` → FAIL.
- [ ] **Step 4:** Implementar el `case`.
- [ ] **Step 5:** Step 3 → PASS; `npm test`; gate.
- [ ] **Step 6:** Comprobar (sin cambiar código) que un proveedor sin eventos propios ve la campana y que su evento contratado aparece en el selector: leer `app-layout.tsx`, `events-store.ts` y lo que devuelve `GET /events` del backend para un proveedor (`ListEventsUseCase`). Anotar el resultado en el informe; si no aparece, es un hueco para otra ronda.
- [ ] **Step 7: Commit** `feat(notifications): texto del aviso de proveedor contratado`
