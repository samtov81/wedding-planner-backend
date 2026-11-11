# Timeline con proveedores (backend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El cronograma relaciona cada ítem con proveedores contratados. Esos proveedores lo leen, lo confirman y reciben un recordatorio 15 minutos antes de cada ítem en el que participan. El planner tiene notas privadas y cualquiera puede descargar el PDF.

**Architecture:** Se amplía el módulo `schedule`:
- dos tablas nuevas, asignaciones y notas;
- la confirmación vive en la asignación;
- los recordatorios son jobs diferidos de BullMQ en una cola propia `schedule`, con un worker que vuelve a comprobar el estado antes de avisar;
- `ScheduleRemindersModule` (módulo "writer", como `NotificationWriterModule`) exporta `RECORDATORIOS_PORT` para que `vendors` reprograme al recontratar sin importar los controladores de `schedule`;
- el PDF se genera con `pdfkit` a partir de un modelo puro que decide qué entra según el rol.

**Tech Stack:** NestJS 11, Prisma 6 / Postgres 16, BullMQ, Socket.IO, Zod, pdfkit, Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-11-10-timeline-proveedores-design.md`. El plan hermano del frontend se ejecuta después y consume la §Contrato: `wedding-planner-frontend/docs/superpowers/plans/2026-11-10-timeline-proveedores-frontend.md`.

## Global Constraints

- Rama `feat/timeline` (ya creada). Sin push ni PR hasta el final. No hacer nunca stage de `.claude/settings.json`.
- Comentarios, docblocks y `describe`/`it` en español; los strings de API, en inglés. Docblocks con la decisión y la alternativa descartada; las decisiones del spec se citan como "spec 2026-11-10 §N".
- Gate de cada tarea: `npm run typecheck && npm run lint && npx prettier --check .` más los tests tocados. Todo cambio de `schema.prisma` lleva migración.
- "Planner" = `esPlannerDelEvento(acceso)`: ADMIN, o miembro con rol `PLANNER`. Nunca `@RequireEventAccess('PLANNER')` a secas, porque `permisosDe(admin)` es `[]`.
- Quien no es planner no ve notas: la ruta de notas le da 404 `SCHEDULE_ITEM_NOT_FOUND`, y ningún JSON ni PDF lleva notas ni `noteCount`.
- Solo se asignan contrataciones `BOOKED` **con** `vendorProfileId` del mismo evento; si no, 422 `SCHEDULE_VENDOR_NOT_ASSIGNABLE` con `details: { eventVendorIds }`. Las asignaciones van por `eventVendorId`; lo que ve y confirma un proveedor es la unión de sus contrataciones `BOOKED`.
- Nota: de 1 a 2.000 caracteres tras `trim`; no se edita ni se borra.
- Un cambio de `startsAt` o de `endsAt` desconfirma todas las asignaciones del ítem. Título, descripción, lugar y estado no desconfirman.
- Recordatorio:
  - a `startsAt − 15 min` (`ANTELACION_RECORDATORIO_MS = 900_000`);
  - solo si el ítem sigue `PENDING`, la asignación existe, la contratación es `BOOKED` y el evento está `ACTIVE`;
  - se descarta si se procesa después de `startsAt`, y no se programa si `startsAt − 15 min` ya pasó.
- jobId del recordatorio: `reminder-<itemId>-<eventVendorId>-<startsAtEpochMs>`. Nunca se borran jobs.
- Escrituras en `UnidadDeTrabajo` con `clienteDe`. Las filas de campana se crean dentro de la transacción y los jobs se encolan después del commit; un fallo al encolar se registra y no se propaga.

## Contrato (HTTP y socket)

Base `events/:eventId/schedule`, con `@UseGuards(JwtAuthGuard, EventAccessGuard)`. Niveles de acceso:
- **T** = `@RequireEventAccess('COUPLE','PLANNER','VENDOR')`;
- **M** = `('COUPLE','PLANNER')`;
- **P** = M más la comprobación `esPlannerDelEvento` en el caso de uso (403 `SCHEDULE_PLANNER_ONLY`);
- **V** = `('VENDOR')`.

| Método y ruta | Acceso | Cuerpo | Respuesta |
|---|---|---|---|
| `GET /` | T | — | 200 `ItemJson[]` (`startsAt asc`) |
| `POST /` | M | lo actual + `eventVendorIds?: uuid[]` (con él, solo P) | 201 `ItemJson` |
| `PATCH /:itemId` | M | lo actual | 200 `ItemJson` |
| `DELETE /:itemId` | M | — | 204 |
| `PUT /:itemId/vendors` | P | `{ eventVendorIds: uuid[] }` (≤ 50, sin repetidos) | 200 `ItemJson` |
| `GET /assignable-vendors` | P | — | 200 `{ eventVendorId, name, categoryName }[]` |
| `GET /:itemId/notes` | P (si no es planner, 404) | — | 200 `NoteJson[]` (cronológico) |
| `POST /:itemId/notes` | P (si no es planner, 404) | `{ body }` | 201 `NoteJson` |
| `GET /confirmations` | T | — | 200 `ConfirmacionesJson` |
| `POST /confirmations` | T | `{ items: { itemId, startsAt, endsAt }[] }` | 200 `ConfirmacionesJson` |
| `POST /notify-vendors` | P, `@LimitePorUsuario('schedule-notify')` (por usuario y evento), 5 por hora | — | 200 `{ notified: number }` |
| `GET /pdf` | T | — | 200 `application/pdf`, `Content-Disposition: attachment; filename="timeline-<YYYY-MM-DD>.pdf"` |

```ts
type ItemJson = {
  id; eventId; title; description: string | null; startsAt: string; endsAt: string | null
  location: Ubicacion | null; status: 'PENDING' | 'IN_PROGRESS' | 'DONE'
  vendors: { eventVendorId: string; name: string; categoryName: string; confirmed: boolean }[]
  noteCount?: number // SOLO para el planner
}
type NoteJson = { id; itemId; body; createdAt; author: { id; name; avatarUrl: string | null } }
type ConfirmacionesJson = {
  ready: number; total: number
  vendors: { userId: string; name: string; avatarUrl: string | null; ready: boolean }[] // por nombre
  mine: { pending: { itemId: string; startsAt: string; endsAt: string | null }[] } | null // sólo proveedor, incluido un miembro que además es proveedor
}
```

- `POST /confirmations` confirma solo las asignaciones del proveedor cuyos ítems siguen con **ese** `startsAt`/`endsAt`. Las demás siguen pendientes (spec §4: la confirmación no pisa una desconfirmación).
- Tipos de campana: `schedule.item.reminder` con `{ scheduleItemId, title, startsAt }`, `schedule.item.rescheduled` con `{ scheduleItemId, title }` y `schedule.confirmation.requested` con `{}`. Los tres llegan en vivo con `notification.created` `{ eventId, type }` por `user:<id>`.
- Códigos: `SCHEDULE_ITEM_NOT_FOUND` 404, `SCHEDULE_PLANNER_ONLY` 403, `SCHEDULE_VENDOR_NOT_ASSIGNABLE` 422, `INVALID_NOTE` 422 y los existentes (`SCHEDULE_STATUS_PLANNER_ONLY`, `INVALID_SCHEDULE_RANGE`).

## Review Focus

1. Un proveedor confirma justo cuando el planner cambia la hora: el ítem cambiado queda pendiente (Task 3 paridad + Task 9 e2e).
2. El planner cambia la hora de A→B y luego vuelve a A: llega **un** recordatorio a la hora A, no dos ni ninguno (Task 6).
3. Se cancela un proveedor con asignaciones y se vuelve a contratar: sale de "Vendors Ready" mientras está cancelado y recupera sus recordatorios futuros al volver (Task 6 + Task 9).
4. El ítem se marca `DONE` antes de la hora: el recordatorio no llega (Task 6).
5. La pareja pide notas, `noteCount` o el PDF: ni un solo byte de notas (Task 7 + Task 9).

---

### Task 1: Esquema, migración, dominio y permiso de planner

**Files:**
- Modify: `prisma/schema.prisma` (modelos `ScheduleItemVendor`, `ScheduleItemNote` y relaciones inversas en `ScheduleItem`, `EventVendor` y `User`)
- Create: `prisma/migrations/20261110120000_schedule_vendors_notes/migration.sql`
- Modify: `docs/DATABASE.md`
- Modify: `src/modules/events/domain/event-access.ts` (+ test)
- Create: `src/modules/schedule/domain/participacion.ts`, `participacion.test.ts`
- Modify: `src/modules/schedule/domain/schedule-errors.ts`

**Interfaces:**
- `events/domain/event-access.ts`: `esPlannerDelEvento(acceso: EventAccess): boolean`. Es true para admin y para member con rol PLANNER. `puedeCambiarEstadoDelCronograma` pasa a delegar en ella; firma y comportamiento iguales.
- `schedule/domain/participacion.ts`:
  - `ANTELACION_RECORDATORIO_MS = 900_000`, `MAX_NOTA = 2000`;
  - `normalizarNota(valor: string): string`, que lanza `UnprocessableError` `INVALID_NOTE`;
  - `cambiaLaHora(antes: { startsAt: Date; endsAt: Date | null }, cambios: { startsAt?: Date | undefined; endsAt?: Date | null | undefined }): boolean`;
  - `momentoDelRecordatorio(startsAt: Date): Date`;
  - `debeProgramarse(startsAt: Date, ahora: Date): boolean` (true si `startsAt − 15 min > ahora`);
  - `debeAvisar(estado: { status: ScheduleItemStatus; startsAt: Date }, startsAtDelJob: Date, ahora: Date): boolean` (PENDING, mismo `startsAt`, `ahora <= startsAt`).
- `schedule-errors.ts`:
  - `SoloPlannerError` (403 `SCHEDULE_PLANNER_ONLY`);
  - `ProveedorNoAsignableError(ids: string[])` (422 `SCHEDULE_VENDOR_NOT_ASSIGNABLE`, `details: { eventVendorIds }`).

- [ ] **Step 1: Tests**
  - `esPlannerDelEvento`: admin → true; PLANNER (owner o no) → true; COUPLE → false; vendor → false; none → false.
  - `cambiaLaHora`: solo cambia el título → false; mismo `startsAt` → false; `startsAt` distinto → true; `endsAt` de null a fecha → true; `endsAt` igual → false.
  - `debeProgramarse`: true con 16 min de margen; false con 15 o menos.
  - `debeAvisar`:
    - PENDING + mismo `startsAt` + a tiempo → true;
    - DONE → false; IN_PROGRESS → false;
    - `startsAt` del job distinto → false;
    - `ahora > startsAt` → false.
  - `normalizarNota`: vacía, solo espacios y 2.001 → `INVALID_NOTE`; 2.000 pasa.
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3: Esquema**
  - `ScheduleItemVendor` (`schedule_item_vendors`):
    - `id`, `scheduleItemId` (cascade), `eventVendorId` (**cascade**), `assignedById` (→ User, restrict), `createdAt`, `confirmedAt DateTime?`;
    - `@@unique([scheduleItemId, eventVendorId])` y `@@index([eventVendorId])`.
  - `ScheduleItemNote` (`schedule_item_notes`):
    - `id`, `scheduleItemId` (cascade), `authorId` (→ User, restrict), `body`, `createdAt`;
    - `@@index([scheduleItemId, createdAt])`.
  - Migración con `--create-only` y, a mano, el CHECK `schedule_item_notes_cuerpo` (`char_length(btrim(body)) BETWEEN 1 AND 2000`).
  - Verificar con `prisma migrate diff` contra un Postgres desechable: sin diferencias.
- [ ] **Step 4:** Documentar en `docs/DATABASE.md`. Gate. Commit `feat(schedule): esquema de asignaciones y notas, y permiso de planner`.

### Task 2: Repositorio — asignaciones y confirmaciones

**Files:**
- Modify: `src/modules/schedule/application/schedule-item.repository.ts`, `infrastructure/schedule-item.repository.fake.ts`, `infrastructure/prisma-schedule-item.repository.ts`, `infrastructure/schedule-item.repository.paridad.test.ts`
- Create: `infrastructure/prisma-schedule-item.repository.test.ts` (integración), si no existe

**Interfaces (se añaden al puerto existente):**

```ts
export interface AsignacionVista { eventVendorId: string; name: string; categoryName: string; confirmed: boolean }
export interface ItemConAsignaciones extends ScheduleItem { vendors: AsignacionVista[] }
export interface Asignable { eventVendorId: string; name: string; categoryName: string; userId: string }
export interface EstadoProveedor { userId: string; name: string; avatarKey: string | null; ready: boolean }
export interface PendienteDeProveedor { itemId: string; startsAt: Date; endsAt: Date | null }
// en ScheduleItemRepository:
listarConAsignaciones(eventId: string): Promise<ItemConAsignaciones[]>   // startsAt asc, id asc
buscarConAsignaciones(eventId: string, itemId: string): Promise<ItemConAsignaciones | null>
listarAsignables(eventId: string): Promise<Asignable[]>                   // BOOKED con ficha, por nombre
fijarAsignaciones(itemId: string, eventVendorIds: string[], por: string): Promise<{ altas: string[]; bajas: string[] }>
desconfirmarItem(itemId: string): Promise<void>
usuariosAsignados(itemId: string): Promise<string[]>                      // userIds con contratación BOOKED
estadoConfirmaciones(eventId: string): Promise<EstadoProveedor[]>
pendientesDe(eventId: string, userId: string): Promise<PendienteDeProveedor[]>
confirmar(eventId: string, userId: string, vistos: PendienteDeProveedor[]): Promise<void>
usuariosConPendientes(eventId: string): Promise<string[]>
```

- Todas las lecturas y escrituras van con `clienteDe(this.prisma)`. `crear` y `actualizar` también pasan a `clienteDe`, porque ahora corren dentro de `UnidadDeTrabajo`.
- "Vigente" = asignación cuya contratación es `BOOKED` y tiene ficha. Lo que no es vigente no cuenta en `estadoConfirmaciones`, `pendientesDe`, `usuariosConPendientes` ni `usuariosAsignados`.
- `vendors` de un ítem lista las vigentes, ordenadas por nombre.
- Un proveedor con dos contrataciones `BOOKED` es **un** `EstadoProveedor`, y está `ready` si todas sus asignaciones vigentes tienen `confirmedAt`.
- `confirmar` pone `confirmedAt = now()` solo en las asignaciones vigentes del usuario que cumplan las dos condiciones:
  - el ítem está entre `vistos`;
  - su `startsAt` y su `endsAt` actuales son **iguales** a los vistos.
- `fijarAsignaciones`: las altas nacen con `confirmedAt` null y las bajas se borran.
- El doble ofrece sembradores para contrataciones (`id`, `eventId`, `userId | null`, `name`, `categoryName`, `status`), usuarios y estado del evento.

- [ ] **Step 1: Paridad** (doble y Prisma):
  - `listarConAsignaciones` trae los `vendors` con `confirmed`.
  - `listarAsignables` excluye SHORTLISTED, CANCELLED y externos.
  - `fijarAsignaciones`: `[a,b]` → `{altas:[a,b]}`; `[b]` → `{bajas:[a]}`; `[b]` otra vez → vacío.
  - `desconfirmarItem` deja `confirmed:false`.
  - **Review Focus 1:** el proveedor ve los pendientes, el ítem 1 cambia de hora y luego `confirmar` con los vistos. El ítem 1 sigue pendiente y el 2 queda confirmado.
  - Un proveedor con dos contrataciones aparece una sola vez en `estadoConfirmaciones`.
  - Contratación CANCELLED: desaparece de `estadoConfirmaciones` y de `usuariosAsignados`; vuelve a BOOKED y reaparece.
  - `usuariosConPendientes` solo devuelve usuarios con alguna asignación vigente sin confirmar.
- [ ] **Step 2: Integración:**
  - una segunda fila `(item, eventVendor)` → P2002;
  - borrar el ítem borra sus asignaciones;
  - borrar la contratación borra sus asignaciones.
- [ ] **Step 3:** FAIL → implementar → PASS. Gate. Commit `feat(schedule): asignaciones y confirmaciones en el repositorio`.

### Task 3: Repositorio — notas y consultas de recordatorio

**Files:** los mismos cuatro ficheros de Task 2.

**Interfaces (se añaden):**

```ts
export interface NotaDeItem { id: string; itemId: string; body: string; createdAt: Date; author: { id: string; name: string; avatarKey: string | null } }
export interface DestinoRecordatorio { userId: string; eventId: string; title: string; status: ScheduleItemStatus; startsAt: Date }
listarNotas(itemId: string): Promise<NotaDeItem[]>          // cronológico
crearNota(itemId: string, authorId: string, body: string): Promise<NotaDeItem>
contarNotas(eventId: string): Promise<Map<string, number>>  // itemId → n
/** null si el ítem no existe, la asignación no está, la contratación no es BOOKED o el evento no es ACTIVE. */
destinoRecordatorio(itemId: string, eventVendorId: string): Promise<DestinoRecordatorio | null>
/** Asignaciones vigentes de esa contratación con startsAt futuro (para reprogramar al recontratar). */
asignacionesFuturas(eventVendorId: string, ahora: Date): Promise<{ itemId: string; startsAt: Date }[]>
```

- [ ] **Step 1: Paridad:**
  - las notas salen en orden;
  - `contarNotas` devuelve el número de cada ítem;
  - `destinoRecordatorio` devuelve null en cada uno de sus 4 casos y el destino correcto cuando es válido;
  - `asignacionesFuturas` excluye los ítems pasados y las asignaciones de otra contratación.
- [ ] **Step 2: Integración:** el CHECK de la nota rechaza `''` y 2.001 caracteres con un `$executeRaw` etiquetado.
- [ ] **Step 3:** FAIL → implementar → PASS. Gate. Commit `feat(schedule): notas y consultas de recordatorio`.

### Task 4: Campana para los tres tipos del cronograma

**Files:** `src/modules/notifications/application/notification.port.ts`, `infrastructure/prisma-notification.repository.ts`, `infrastructure/notification.repository.fake.ts`, `infrastructure/notification.repository.paridad.test.ts`

**Interfaces:**
- En `notification.port.ts`:
  - `TIPO_CRONOGRAMA_RECORDATORIO = 'schedule.item.reminder'`;
  - `TIPO_CRONOGRAMA_REPROGRAMADO = 'schedule.item.rescheduled'`;
  - `TIPO_CRONOGRAMA_CONFIRMACION = 'schedule.confirmation.requested'`;
  - `TIPOS_CRONOGRAMA` (los tres);
  - `TIPOS_PARA_PROVEEDOR = [...TIPOS_MOODBOARD, ...TIPOS_CRONOGRAMA]`.
- `visiblesDe`: la rama del moodboard pasa a usar `TIPOS_PARA_PROVEEDOR`, con la misma regla (miembro ACTIVE, o proveedor BOOKED en evento ACTIVE). El doble se cambia igual.

- [ ] **Step 1: Paridad:**
  - un proveedor BOOKED ve un `schedule.item.reminder` creado con `crearParaUsuarios`;
  - con la contratación CANCELLED deja de verlo;
  - sigue sin ver un tipo de miembro (p. ej. `guest.rsvp.updated`).
- [ ] **Step 2:** FAIL → implementar → PASS. Gate. Commit `feat(notifications): avisos del cronograma visibles para el proveedor`.

### Task 5: Casos de uso — asignar, editar con reconfirmación, notas, confirmar y avisar

**Files:**
- Create:
  - `src/modules/schedule/application/avisos-cronograma.ts`
  - `src/modules/schedule/application/participacion.use-cases.ts`
  - `src/modules/schedule/application/participacion.use-cases.test.ts`
- Modify:
  - `create-schedule-item.use-case.ts`, `update-schedule-item.use-case.ts` (y sus tests en `schedule-items.use-cases.test.ts`)
  - `src/modules/queue/application/queue.port.ts` (`QueueName` + `'schedule'`)

**Interfaces:**
- Consumes:
  - el puerto de Tasks 2 y 3;
  - `NOTIFICATION_PORT.crearParaUsuarios` y los tipos de Task 4;
  - `UnidadDeTrabajo` y `QUEUE_PORT`;
  - el dominio de Task 1.
- Produces, en `avisos-cronograma.ts`:
  - `COLA_CRONOGRAMA = 'schedule'`;
  - `EVENTO_RECORDATORIO = 'schedule.item.reminder'` (nombre del job);
  - `EVENTO_CAMPANA = 'schedule.bell'` (job de empuje en vivo);
  - `JobRecordatorio { itemId: string; eventVendorId: string; startsAt: string }` (ISO);
  - `JobCampana { eventId: string; tipo: string; userIds: string[] }`;
  - `jobIdDeRecordatorio(itemId, eventVendorId, startsAt: Date)` → `reminder-<itemId>-<eventVendorId>-<epochMs>`;
  - `encolarRecordatorios(cola, registro, asignaciones: { itemId; eventVendorId; startsAt: Date }[], ahora: Date)`: solo las que `debeProgramarse`, con `delayMs = momentoDelRecordatorio − ahora`;
  - `encolarCampana(cola, registro, job)`: jobId `bell-<tipo>-<eventId>-<epochMs>`.
  - Ninguna de las dos propaga errores.
- Produces, casos de uso. El actor es `{ userId, esPlanner: boolean }`, que construye el controlador (Task 8):
  - **`CreateScheduleItemUseCase.ejecutar(eventId, datos, actor, eventVendorIds?: string[])`:**
    - con `eventVendorIds` y `!esPlanner` → `SoloPlannerError`;
    - dentro de la UdT: crear y luego `fijarAsignaciones`;
    - ids fuera de `listarAsignables` → `ProveedorNoAsignableError`;
    - después del commit, recordatorios de las altas;
    - devuelve `ItemConAsignaciones`.
  - **`UpdateScheduleItemUseCase`:**
    - dentro de la UdT: actualizar;
    - si `cambiaLaHora`: `desconfirmarItem` y `crearParaUsuarios(eventId, usuariosAsignados(item), TIPO_CRONOGRAMA_REPROGRAMADO, { scheduleItemId, title })`;
    - después del commit: `encolarCampana` y `encolarRecordatorios` de todas sus asignaciones vigentes con la hora nueva;
    - la regla de estado de siempre se mantiene;
    - devuelve `ItemConAsignaciones`.
  - **`AsignarProveedoresUseCase.ejecutar(eventId, itemId, actor, eventVendorIds)`:** solo planner. Hace la validación de asignables. Después del commit, recordatorios de las altas.
  - **`ListarAsignablesUseCase`**, **`ListarItemsUseCase.ejecutar(eventId, esPlanner)`** (`noteCount` solo si es planner), **`ListarNotasUseCase`** y **`CrearNotaUseCase`**:
    - las de notas lanzan `ItemDeCronogramaNoEncontradoError` si `!esPlanner` o si el ítem no existe.
  - **`ConfirmacionesUseCase.estado(eventId, userIdDelProveedor | null)`** y **`.confirmar(eventId, userId, vistos)`**:
    - devuelven `{ ready, total, vendors, mine }`.
  - **`AvisarProveedoresUseCase.ejecutar(eventId, actor)`:**
    - solo planner;
    - `usuariosConPendientes`; si hay alguno, `crearParaUsuarios(…, TIPO_CRONOGRAMA_CONFIRMACION, {})` dentro de la UdT y después `encolarCampana`;
    - devuelve `{ notified: n }`.

- [ ] **Step 1: Tests unitarios** contra dobles:
  - crear con proveedores siendo pareja → `SCHEDULE_PLANNER_ONLY` y nada creado;
  - un id no asignable → 422 con `details.eventVendorIds` y nada creado;
  - editar solo el título → ni desconfirma ni avisa;
  - editar `startsAt`:
    - desconfirma;
    - crea `schedule.item.rescheduled` para los asignados;
    - encola recordatorios con jobId de la hora nueva;
  - una hora a menos de 15 min → no encola recordatorio;
  - notas siendo pareja → `SCHEDULE_ITEM_NOT_FOUND`;
  - `noteCount` ausente para la pareja;
  - "Notify Vendors" sin pendientes → `{ notified: 0 }`, sin campana y sin job;
  - un fallo de cola no tumba la operación.
- [ ] **Step 2:** FAIL → implementar → PASS. Gate. Commit `feat(schedule): asignar, reconfirmar, notas y avisos a proveedores`.

### Task 6: Recordatorios — worker, módulo writer y recontratación

**Files:**
- Create:
  - `src/modules/schedule/application/recordatorios.port.ts`
  - `src/modules/schedule/application/programar-recordatorios.ts` (+ test)
  - `src/modules/schedule/interfaces/schedule.processor.ts` (+ test)
  - `src/modules/schedule/schedule-reminders.module.ts`
- Modify: `src/modules/vendors/application/update-event-vendor.use-case.ts` (+ test), `src/modules/vendors/vendors.module.ts`

**Interfaces:**
- `recordatorios.port.ts`: `interface RecordatoriosPort { reprogramarContratacion(eventVendorId: string): Promise<void> }` y `RECORDATORIOS_PORT`.
- `ProgramarRecordatorios implements RecordatoriosPort`: `asignacionesFuturas(eventVendorId, ahora)` → `encolarRecordatorios`. No lanza.
- `ScheduleRemindersModule`:
  - provee el repositorio del cronograma (o lo recibe), `QUEUE_PORT` y `ProgramarRecordatorios`;
  - exporta `RECORDATORIOS_PORT`;
  - **no** importa `VendorsModule`.
- `UpdateEventVendorUseCase`: después del commit, cuando el resultado es la transición a `BOOKED` (`resultado.contratado` presente), llama a `recordatorios.reprogramarContratacion(eventVendorId)`. La transición a CANCELLED no hace nada; el worker descarta.
- `ScheduleProcessor` (cola `schedule`):
  - `EVENTO_RECORDATORIO`:
    - `destinoRecordatorio(itemId, eventVendorId)`;
    - si es null, o `!debeAvisar(destino, new Date(job.startsAt), ahora)`, completa sin hacer nada;
    - si no, `crearParaUsuarios(destino.eventId, [destino.userId], TIPO_CRONOGRAMA_RECORDATORIO, { scheduleItemId, title, startsAt })` y emite `NOTIFICACION_CREADA` a `user:<id>`.
  - `EVENTO_CAMPANA`: emite `NOTIFICACION_CREADA { eventId, type }` a cada `userIds`.
  - Jobs validados con Zod (`satisfies`); un payload roto lanza `UnrecoverableError`.
  - `ScheduleModule` registra la cola e importa `ScheduleRemindersModule` y `NotificationsModule` (`REALTIME_PORT`).

- [ ] **Step 1: Tests:**
  - **Review Focus 2:** A→B→A encola tres jobs con jobIds distintos; al procesarlos, solo avisan los de la hora A vigente. Los jobIds de A coinciden, así que BullMQ deduplica y llega uno.
  - **Review Focus 4:** el ítem ya está DONE → no avisa.
  - Procesado después de `startsAt` → no avisa.
  - Contratación CANCELLED → no avisa.
  - **Review Focus 3:** al recontratar se encolan los recordatorios futuros, verificado con un test de `UpdateEventVendorUseCase` con `RECORDATORIOS_PORT` falso.
  - `npm run lint` sin ciclos: `vendors` importa `ScheduleRemindersModule`, que no importa `vendors`.
- [ ] **Step 2:** FAIL → implementar → PASS. `npm run build && npm run test:smoke`. Gate. Commit `feat(schedule): recordatorios 15 minutos antes y reprogramación al recontratar`.

### Task 7: PDF del cronograma

**Files:**
- Modify: `package.json` (`pdfkit` y `@types/pdfkit` en devDependencies)
- Create:
  - `src/modules/schedule/application/pdf-cronograma.ts` (modelo puro) + test
  - `src/modules/schedule/application/pdf.port.ts`
  - `src/modules/schedule/infrastructure/pdfkit-cronograma.ts` (+ test)
  - `src/modules/schedule/application/descargar-pdf.use-case.ts`

**Interfaces:**
- `pdf-cronograma.ts`:
  - `interface DocumentoCronograma { titulo: string; fecha: string; items: { hora: string; titulo: string; lugar: string | null; descripcion: string | null; estado: string; proveedores: string[]; notas: string[] }[] }`;
  - `componerDocumento(evento: { name; weddingDate; timezone }, items: ItemConAsignaciones[], notasPorItem: Map<string, NotaDeItem[]> | null): DocumentoCronograma`.
  - Con `notasPorItem === null` (quien no es planner), `notas` es `[]` siempre.
  - Las horas se formatean en `evento.timezone` (`Intl.DateTimeFormat`, `HH:mm`, con el fin si existe: `"16:00–17:30"`).
  - Cada proveedor sale como `"<name> (<categoryName>) ✓"` si está confirmado; si no, sin la marca.
- `pdf.port.ts`: `interface GeneradorPdf { generar(doc: DocumentoCronograma): Promise<Buffer> }` y `GENERADOR_PDF`.
- `PdfkitCronograma implements GeneradorPdf`: A4, fuente Helvetica (cubre los acentos del español), una sección por ítem.
- `DescargarPdfUseCase.ejecutar(eventId, esPlanner): Promise<{ buffer: Buffer; filename: string }>`, con `filename = timeline-<YYYY-MM-DD de weddingDate en su timezone>.pdf`. El evento se lee con `EVENT_REPOSITORY.buscarPorId` (exportado por `EventsModule`).

- [ ] **Step 1: Tests:**
  - `componerDocumento`:
    - con notas → las incluye;
    - con `null` → ningún ítem trae notas (**Review Focus 5**);
    - una hora en `America/Bogota` sale en hora local;
    - la marca ✓ solo sale en los confirmados.
  - `PdfkitCronograma.generar` → el buffer empieza por `%PDF-` y mide más de 1 KB.
- [ ] **Step 2:** FAIL → implementar → PASS. Gate. Commit `feat(schedule): PDF del cronograma con notas sólo para el planner`.

### Task 8: HTTP y cableado

**Files:**
- Modify: `src/modules/schedule/interfaces/schedule.controller.ts`, `schedule.dto.ts`, `src/modules/schedule/schedule.module.ts`, `src/shared/http/limitadores.ts`
- Create: `src/modules/schedule/interfaces/schedule.json.ts`

**Interfaces:**
- Consumes: todo lo anterior.
- Rutas y respuestas **exactamente** como en §Contrato. El actor es `{ userId, esPlanner: esPlannerDelEvento(acceso) }` y el `userId` del proveedor sale de `CurrentUser`.
- Las rutas `assignable-vendors`, `confirmations`, `notify-vendors` y `pdf` se declaran **antes** de `/:itemId`, para que el router no las capture.
- Limitador `schedule-notify`: 5 por hora (`ttl: 3_600_000`, `limit: 5`), por IP, que es el criterio de la casa.
- Avatares firmados con `firmarLectura`, como en el moodboard.
- El PDF responde con `@Res({ passthrough: true })`, `Content-Type: application/pdf` y `Content-Disposition`.

- [ ] **Step 1:** Implementar y ejecutar los tests existentes de schedule. `npm run build && npm run test:smoke`. Gate. Commit `feat(schedule): rutas de proveedores, confirmaciones, notas y PDF`.

### Task 9: E2E

**Files:** Create `test/e2e/schedule-proveedores.e2e.test.ts`. Modify `test/e2e/schedule.e2e.test.ts` solo si alguna aserción existente cambia de forma, por ejemplo por `vendors` en la respuesta.

Fixture:
- creador (PLANNER y dueño), pareja no creadora, planner no creador;
- proveedor A con dos contrataciones BOOKED, de las cuales solo una está asignada;
- proveedor B BOOKED sin asignar, proveedor C SHORTLISTED;
- extraño y admin.

- [ ] **Step 1: Tests:**
  - **Matriz:** `it.each` sobre las rutas de §Contrato × {creador, pareja, planner, A, B, extraño}, con el status exacto.
  - **Notas:**
    - pareja, A y B → 404 en la ruta de notas;
    - `GET /` sin `noteCount` para ellos y con `noteCount` para los planners;
    - el PDF de la pareja no contiene el texto de la nota: comprobarlo con un PDF sin comprimir, inyectando la opción `compress: false` del generador en test, o afirmarlo sobre el `DocumentoCronograma` que llega al generador falso.
  - **Asignar C** → 422 `SCHEDULE_VENDOR_NOT_ASSIGNABLE`.
  - **Confirmar:**
    - A confirma → `ready` pasa a 1 de 1.
    - El planner cambia la hora → A recibe `schedule.item.rescheduled` en `GET /me/notifications` y vuelve a pendiente.
    - **Review Focus 1:** A confirma con los `vistos` viejos → sigue pendiente.
  - **"Notify Vendors":** `{ notified: 1 }`; a la sexta llamada en una hora → 429.
  - **Recordatorio** con el retraso acortado: inyectar un `ahora` o un `ANTELACION` corto por token solo en test, o un ítem a 15 min + 2 s.
    - A recibe `schedule.item.reminder` por socket (`notification.created`) y lo tiene en la campana.
    - Tras desasignar, otro ítem no avisa (espera acotada).
  - **Recontratación:** CANCELLED → `total` baja; BOOKED otra vez → vuelve.
  - **PDF:** `GET /pdf` → 200, `application/pdf`, `Content-Disposition` con `timeline-`.
- [ ] **Step 2:** PASS. Si sale un fallo de producción, se arregla en su tarea dueña con su test y un commit `fix(schedule): …`.
- [ ] **Step 3:** Pasar `npm test`, typecheck, lint, prettier, `npm run build && npm run test:smoke` y `prisma migrate diff`. Commit `test(schedule): e2e de proveedores, confirmaciones, recordatorios y PDF`.
