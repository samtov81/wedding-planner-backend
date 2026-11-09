# Moodboard (backend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API del tablero de inspiración compartido por evento: fotos con categoría, archivado, compartir foto a foto con proveedores contratados, conversación común por foto, resumen con colaboradores y presencia en tiempo real.

**Architecture:** Módulo nuevo `src/modules/moodboard/` (cuatro capas). Un único puerto `MOODBOARD_REPOSITORY` (doble + Prisma + paridad). La visibilidad del proveedor la resuelve el repositorio con la unión de sus contrataciones `BOOKED` (nunca `EventAccess.vendor.eventVendorId`). Los avisos van por una cola propia `moodboard`, cuyo worker emite al socket; la campana se persiste dentro de la transacción con un método nuevo de `NotificationPort`. La presencia es un puerto nuevo `PRESENCE_PORT` en `notifications` (Redis), alimentado por `NotificationsGateway`.

**Tech Stack:** NestJS 11, Prisma 6 / Postgres 16, ioredis, BullMQ, Socket.IO, Zod, Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-11-09-moodboard-design.md`. Plan hermano del frontend: `wedding-planner-frontend/docs/superpowers/plans/2026-11-09-moodboard-frontend.md` (se ejecuta después y consume el contrato HTTP/socket fijado aquí en §Contrato).

## Global Constraints

- Rama `feat/moodboard` (ya creada desde `develop`). Sin push ni PR hasta el final. Nunca hacer stage de `.claude/settings.json`.
- Español en comentarios, docblocks y `describe`/`it`; strings de API en inglés. Prettier: sin `;`, comillas simples, ancho 100. Docblocks con la decisión y la alternativa descartada; las decisiones marcadas *(mi decisión)* en el spec se citan como "spec 2026-11-09 §N".
- Gate por tarea: `npm run typecheck && npm run lint && npx prettier --check .` + los tests tocados. Todo cambio de `schema.prisma` lleva migración.
- Nada se borra por la API: ni fotos, ni notas, ni comparticiones (se revocan con `revokedAt`).
- Título 1–120 caracteres tras `trim`; nota 1–2.000 tras `trim`; `width`/`height` enteros 1–20000.
- Tope **500** fotos por evento (activas + archivadas), validado tras `SELECT id FROM events WHERE id = $1 FOR UPDATE` dentro de `UnidadDeTrabajo`.
- Imagen: reutilizar `SubidaDeImagenes` con prefijo `events/<eventId>/moodboard` (JPG/PNG/WebP ≤ 10 MB).
- Fuera del evento → 404; proveedor sin permiso de la acción → 403; foto no compartida con el proveedor, o archivada, → 404 `MOODBOARD_IMAGE_NOT_FOUND`.
- Sólo se comparte con `EventVendor` del mismo evento, `BOOKED` y con `vendorProfileId`.
- Presencia: TTL de socket **75 s**, latido cada **30 s**, gracia de desconexión **20 s**.

## Contrato (HTTP y socket)

Todas bajo `@UseGuards(JwtAuthGuard, EventAccessGuard)` y `events/:eventId/moodboard`. "M" = `@RequireEventAccess('COUPLE', 'PLANNER')`; "T" = `@RequireEventAccess('COUPLE', 'PLANNER', 'VENDOR')`.

| Método y ruta | Acceso | Cuerpo / query | Respuesta |
|---|---|---|---|
| `POST /upload-url` | M | `{ contentType, bytes }` | 201 `{ key, uploadUrl }` |
| `POST /images` | M | `{ key, title, categoryId, width, height }` | 201 `ImageJson` |
| `GET /images` | T | `?archived=true` (sólo M; proveedor → 403) | 200 `ImageJson[]` (más nuevas primero) |
| `GET /images/:imageId` | T | — | 200 `ImageJson` |
| `PATCH /images/:imageId` | M | `{ archived: boolean }` | 200 `ImageJson` |
| `PUT /images/:imageId/shares` | M | `{ eventVendorIds: uuid[] }` (≤ 50, sin repetidos) | 200 `ImageJson` |
| `GET /shareable-vendors` | M | — | 200 `{ eventVendorId, name, categoryName }[]` |
| `GET /images/:imageId/notes` | T | — | 200 `NoteJson[]` (cronológico) |
| `POST /images/:imageId/notes` | T | `{ body }` | 201 `NoteJson` |
| `GET /summary` | T | — | 200 `SummaryJson` |

```ts
type ImageJson = {
  id: string; title: string; url: string | null; width: number; height: number
  category: { id: string; slug: string; name: string }
  uploadedBy: { id: string; name: string }
  createdAt: string; archivedAt: string | null; noteCount: number
  sharedWith?: { eventVendorId: string; name: string }[] // SÓLO para miembros
}
type NoteJson = { id: string; imageId: string; body: string; createdAt: string
  author: { id: string; name: string; avatarUrl: string | null } }
type SummaryJson = {
  stats: { images: number; notes: number }
  activity: { kind: 'image' | 'note'; imageId: string; actorName: string; categoryName: string; at: string }[] // ≤ 10
  collaborators: { userId: string; name: string; avatarUrl: string | null
    role: 'COUPLE' | 'PLANNER' | 'VENDOR'; label: string; online: boolean }[]
}
```

Códigos: `MOODBOARD_IMAGE_NOT_FOUND` 404, `MOODBOARD_IMAGE_LIMIT` 422, `MOODBOARD_IMAGE_ARCHIVED` 422, `MOODBOARD_INVALID_CATEGORY` 422, `MOODBOARD_VENDOR_NOT_SHAREABLE` 422 (`details: { eventVendorIds }`), `MOODBOARD_UPLOAD_ALREADY_USED` 409 (la `key` ya dio de alta una foto: reintento de `POST /images`), más los de storage (`INVALID_IMAGE`, `INVALID_UPLOAD`, `STORAGE_UNAVAILABLE`).

Socket (namespace `/realtime`), todos con payload de **ids** — el cliente vuelve a leer por REST:

- `moodboard.image.changed` `{ eventId, imageId }` → `event:<id>` y a `user:<id>` de cada proveedor que **ahora** ve la foto.
- `moodboard.image.hidden` `{ eventId, imageId }` → `user:<id>` de cada proveedor que **dejó** de verla (revocada o archivada).
- `moodboard.note.created` `{ eventId, imageId, noteId }` → igual que `image.changed`.
- `notification.created` `{ eventId, type }` → `user:<id>` de los destinatarios de la campana.
- `presence.changed` `{ userId, online }` → ver Task 5.

Campana: `moodboard.image.shared` payload `{ imageId }`; `moodboard.note.added` payload `{ imageId, noteId }`.

## Review Focus

1. Un proveedor contratado DOS veces en el evento (dos `EventVendor` BOOKED de la misma ficha) con fotos compartidas a cada contratación ve las de ambas, en lista, en `GET /images/:id`, en notas y en el resumen (Task 2 paridad + Task 8 e2e).
2. Dos `POST /images` concurrentes con 499 fotos → una 201 y otra 422 `MOODBOARD_IMAGE_LIMIT`, nunca 501 filas (Task 2 integración).
3. Revocar y volver a compartir con el mismo proveedor reaviva la fila (UNIQUE intacto), vuelve a sonar la campana y el proveedor recupera sus notas antiguas (Task 6 unit + Task 8 e2e).
4. Un socket que se reconecta dentro de la gracia (renovación del token cada 15 min) NO emite `presence.changed` offline/online (Task 5).
5. Un proveedor con la foto revocada que escribió notas en ella no recibe la campana de una nota nueva ni el `note.created` (Task 6 unit + Task 7 processor).

---

### Task 1: Esquema, migración, dominio y errores

**Files:**
- Modify: `prisma/schema.prisma` (modelos `MoodboardImage`, `MoodboardShare`, `MoodboardNote` + relaciones inversas en `Event`, `User`, `VendorCategory`, `EventVendor`)
- Create: `prisma/migrations/20261109120000_moodboard/migration.sql`
- Modify: `docs/DATABASE.md` (tres tablas, sus CHECK y qué valida el caso de uso: tope 500, contratación compartible)
- Create: `src/modules/moodboard/domain/moodboard.ts`, `moodboard.test.ts`, `moodboard-errors.ts`

**Interfaces:**
- Produces (`domain/moodboard.ts`):
  - `MAX_IMAGENES_POR_EVENTO = 500`, `MAX_TITULO = 120`, `MAX_NOTA = 2000`, `MAX_DIMENSION = 20000`
  - `normalizarTitulo(valor: string): string` y `normalizarNota(valor: string): string` — `trim`; lanzan `UnprocessableError` (`INVALID_TITLE` / `INVALID_NOTE`) si queda vacío o supera el máximo.
  - `type Visor = { tipo: 'miembro'; userId: string } | { tipo: 'proveedor'; userId: string }`
  - `exigirActiva(imagen: { archivedAt: Date | null }): void` → lanza `ImagenArchivadaError`.
  - `exigirCupo(actuales: number): void` → lanza `TopeDeImagenesError` si `actuales >= 500`.
- Produces (`domain/moodboard-errors.ts`): `ImagenNoEncontradaError` (404 `MOODBOARD_IMAGE_NOT_FOUND`), `TopeDeImagenesError` (422 `MOODBOARD_IMAGE_LIMIT`), `ImagenArchivadaError` (422 `MOODBOARD_IMAGE_ARCHIVED`), `CategoriaInvalidaError` (422 `MOODBOARD_INVALID_CATEGORY`), `ProveedorNoCompartibleError(ids: string[])` (422 `MOODBOARD_VENDOR_NOT_SHAREABLE`, `details: { eventVendorIds }`).

- [ ] **Step 1: Tests de dominio** (`moodboard.test.ts`): `normalizarTitulo('  Peonías ')` → `'Peonías'`; `''`, `'   '` y 121 caracteres lanzan con código `INVALID_TITLE`; 120 pasa. Igual para nota con 2.000/2.001 y `INVALID_NOTE`. `exigirCupo(499)` no lanza, `exigirCupo(500)` lanza `MOODBOARD_IMAGE_LIMIT`. `exigirActiva({ archivedAt: new Date() })` lanza `MOODBOARD_IMAGE_ARCHIVED`.
- [ ] **Step 2:** `npx vitest run src/modules/moodboard/domain` → FAIL (módulo no existe).
- [ ] **Step 3:** Implementar dominio y errores (subclases de `NotFoundError`/`UnprocessableError` de `@/shared/domain`).
- [ ] **Step 4:** Esquema Prisma según spec §5:
  - `MoodboardImage`: `id`, `eventId` (cascade), `categoryId` (restrict), `title`, `storageKey @unique`, `width Int`, `height Int`, `uploadedById`, `archivedAt DateTime?`, `archivedById String? @db.Uuid`, `createdAt`, `updatedAt`; `@@index([eventId, createdAt])`; `@@map("moodboard_images")`.
  - `MoodboardShare`: `id`, `imageId` (cascade), `eventVendorId` (restrict), `sharedById`, `createdAt`, `revokedAt DateTime?`; `@@unique([imageId, eventVendorId])`; `@@index([eventVendorId])`; `@@map("moodboard_shares")`.
  - `MoodboardNote`: `id`, `imageId` (cascade), `authorId`, `body`, `createdAt`; `@@index([imageId, createdAt])`; `@@map("moodboard_notes")`.
  - Generar con `npx prisma migrate dev --name moodboard --create-only` y añadir a mano en el SQL los CHECK:
    - `moodboard_images_titulo` (`char_length(btrim(title)) BETWEEN 1 AND 120`);
    - `moodboard_images_dimensiones` (`width BETWEEN 1 AND 20000 AND height BETWEEN 1 AND 20000`);
    - `moodboard_images_archivado_coherente` (`(archived_at IS NULL) = (archived_by_id IS NULL)`, con los nombres de columna reales);
    - `moodboard_notes_cuerpo` (`char_length(btrim(body)) BETWEEN 1 AND 2000`).
  - Renombrar la carpeta a `20261109120000_moodboard`.
- [ ] **Step 5:** `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url …` como en CI (ver README §Comprobaciones) → sin diferencias. `npx vitest run src/modules/moodboard/domain` → PASS.
- [ ] **Step 6:** Documentar en `docs/DATABASE.md`. Gate. Commit `feat(moodboard): esquema, migración y dominio del tablero`.

### Task 2: Repositorio — fotos y comparticiones

**Files:**
- Create: `src/modules/moodboard/application/moodboard.repository.ts`
- Create: `src/modules/moodboard/infrastructure/moodboard.repository.fake.ts`, `prisma-moodboard.repository.ts`, `prisma-moodboard.repository.test.ts` (integración), `moodboard.repository.paridad.test.ts`

**Interfaces:**
- Produces (`application/moodboard.repository.ts`):

```ts
export interface ImagenDeMoodboard {
  id: string; eventId: string; title: string; storageKey: string; width: number; height: number
  category: { id: string; slug: string; name: string }
  uploadedBy: { id: string; name: string }
  createdAt: Date; archivedAt: Date | null; noteCount: number
  /** Comparticiones vigentes; el controlador sólo la publica a miembros. */
  sharedWith: { eventVendorId: string; name: string }[]
}
export interface DatosNuevaImagen {
  eventId: string; categoryId: string; title: string; storageKey: string
  width: number; height: number; uploadedById: string
}
export interface ContratacionCompartible { eventVendorId: string; name: string; categoryName: string; userId: string }
export interface MoodboardRepository {
  /** `SELECT … FOR UPDATE` de la fila del evento + cuenta de TODAS sus imágenes. Dentro de UnidadDeTrabajo. */
  bloquearYContar(eventId: string): Promise<number>
  categoriaActiva(categoryId: string): Promise<boolean>
  crearImagen(datos: DatosNuevaImagen): Promise<ImagenDeMoodboard>
  listarImagenes(eventId: string, visor: Visor, archivadas: boolean): Promise<ImagenDeMoodboard[]>
  /** null si no existe en ese evento o el visor no la ve (proveedor: compartida vigente y activa). */
  buscarImagen(eventId: string, imageId: string, visor: Visor): Promise<ImagenDeMoodboard | null>
  fijarArchivo(imageId: string, por: string | null): Promise<void>
  listarCompartibles(eventId: string): Promise<ContratacionCompartible[]>
  /** Altas crean o reavivan (revokedAt = null); bajas ponen revokedAt. Devuelve los eventVendorId de cada lado. */
  fijarComparticion(imageId: string, eventVendorIds: string[], por: string): Promise<{ altas: string[]; bajas: string[] }>
  /** userId de las fichas de esas contrataciones (para avisos). */
  usuariosDeContrataciones(eventVendorIds: string[]): Promise<string[]>
  /** userId de los proveedores que HOY ven la foto (compartida vigente, activa, BOOKED, evento ACTIVE). */
  proveedoresQueVen(imageId: string): Promise<string[]>
}
export const MOODBOARD_REPOSITORY = Symbol('MOODBOARD_REPOSITORY')
```

- Produces (fake): `class MoodboardRepositoryFake implements MoodboardRepository` con sembradores `sembrarEvento(eventId, { status })`, `sembrarCategoria({ id, slug, name, active })`, `sembrarUsuario({ id, name, avatarKey? })`, `sembrarContratacion({ id, eventId, userId | null, name, categoryName, status })`, `sembrarMiembro({ eventId, userId, role, status })` (lo usa Task 3).
- Visibilidad de proveedor (doble y Prisma): existe `MoodboardShare` con `revokedAt IS NULL` cuyo `EventVendor` es `BOOKED`, del mismo evento, con `vendorProfile.userId = visor.userId`, y el evento está `ACTIVE`; y la imagen `archivedAt IS NULL`. `archivadas = true` con visor proveedor → `[]` (el 403 lo pone el controlador).
- `listarImagenes`: `createdAt desc, id desc`. `noteCount` cuenta todas las notas de la foto (la conversación es común). `listarCompartibles`: `BOOKED`, `vendorProfileId` no nulo, `name` = `businessName` de la ficha, ordenadas por nombre.

- [ ] **Step 1: Paridad** (`moodboard.repository.paridad.test.ts`, mismo esqueleto que `schedule-item.repository.paridad.test.ts` con `sinVolatiles`). Casos sobre doble **y** Prisma:
  - crear y listar como miembro: orden y `noteCount: 0`;
  - archivadas sólo con `archivadas = true`;
  - un proveedor ve sólo lo compartido con cualquiera de sus **dos** contrataciones BOOKED;
  - deja de verla si se revoca, si se archiva, si su contratación pasa a CANCELLED o si el evento no está ACTIVE;
  - `fijarComparticion(img, [a, b])` y luego `[b]` → `{ altas: [], bajas: [a] }`; después `[a, b]` → `{ altas: [a], bajas: [] }`, y en Prisma sigue habiendo UNA fila `(img, a)`;
  - `listarCompartibles` excluye SHORTLISTED, CANCELLED y externos;
  - `proveedoresQueVen` y `usuariosDeContrataciones` devuelven los `userId` esperados (orden indiferente: comparar ordenados).
- [ ] **Step 2: Integración** (`prisma-moodboard.repository.test.ts`, Postgres en Testcontainers):
  - cada CHECK rechaza vía `prisma.$executeRaw` un INSERT directo: título de 121, título `'  '`, `width = 0`, `archived_at` sin `archived_by_id`, nota vacía y nota de 2.001;
  - `storage_key` duplicada → P2002;
  - segunda fila `(image_id, event_vendor_id)` → P2002;
  - tope con concurrencia: con 499 imágenes, dos `UnidadDeTrabajo` en paralelo que hacen `bloquearYContar` + `exigirCupo` + `crearImagen` → exactamente una falla con `TopeDeImagenesError` y quedan 500 filas.
- [ ] **Step 3:** Ejecutar ambos → FAIL.
- [ ] **Step 4:** Implementar puerto, doble y `PrismaMoodboardRepository` (escribe con `clienteDe(this.prisma)`; el bloqueo con `$queryRaw` etiquetado, nunca `Unsafe`).
- [ ] **Step 5:** `npx vitest run src/modules/moodboard/infrastructure` → PASS. Gate. Commit `feat(moodboard): repositorio de fotos y comparticiones con paridad`.

### Task 3: Repositorio — notas, resumen y destinatarios

**Files:**
- Modify: `application/moodboard.repository.ts`, `infrastructure/moodboard.repository.fake.ts`, `infrastructure/prisma-moodboard.repository.ts`, `moodboard.repository.paridad.test.ts`

**Interfaces:**
- Produces (añadidos al puerto):

```ts
export interface NotaDeMoodboard {
  id: string; imageId: string; body: string; createdAt: Date
  author: { id: string; name: string; avatarKey: string | null }
}
export interface Colaborador {
  userId: string; name: string; avatarKey: string | null
  role: 'COUPLE' | 'PLANNER' | 'VENDOR'; label: string
}
export interface ResumenCrudo {
  stats: { images: number; notes: number }
  activity: { kind: 'image' | 'note'; imageId: string; actorName: string; categoryName: string; at: Date }[]
  collaborators: Colaborador[]
}
// en MoodboardRepository:
listarNotas(imageId: string): Promise<NotaDeMoodboard[]>
crearNota(imageId: string, authorId: string, body: string): Promise<NotaDeMoodboard>
resumen(eventId: string, visor: Visor): Promise<ResumenCrudo>
/** uploadedBy + autores de notas + proveedores que ven, filtrados por quién la VE hoy (miembro ACTIVE o proveedor que ve), sin `excluir`. */
participantes(imageId: string, excluir: string): Promise<string[]>
```

- `resumen` sobre lo que el visor ve (para proveedor: fotos activas compartidas con él):
  - `stats.images` = fotos activas; `stats.notes` = notas de esas fotos.
  - `activity` = las 10 más recientes entre creación de foto y nota, sobre esas fotos.
  - `collaborators`:
    - para miembro: miembros `ACTIVE` (role del enum; `label` `'Couple'`/`'Planner'`) + usuarios de proveedores con ≥ 1 foto activa compartida vigente (`role: 'VENDOR'`, `label` = nombre de la categoría de la contratación; si tiene dos, las dos unidas con `' · '`), un usuario una sola vez;
    - para proveedor: miembros `ACTIVE` + él mismo.
  - Orden: COUPLE, PLANNER, VENDOR y por nombre.
- `ADMIN` que entra sin membresía es `Visor` `miembro` pero no aparece como colaborador.

- [ ] **Step 1: Paridad** (añadir al fichero de Task 2):
  - notas en orden cronológico;
  - `noteCount` refleja las notas;
  - resumen como miembro y como proveedor: un proveedor no cuenta fotos ni notas de fotos no compartidas con él y no ve a otro proveedor en `collaborators`; un proveedor con dos contrataciones sale una vez con label `'Decor & Floral · Venue'`;
  - `activity` limitada a 10 y más reciente primero;
  - `participantes` excluye al autor, incluye a quien subió la foto y a autores previos, y NO incluye a un proveedor revocado que escribió antes ni a un miembro `REVOKED`.
- [ ] **Step 2:** Ejecutar → FAIL. **Step 3:** Implementar en doble y Prisma. **Step 4:** PASS. Gate. Commit `feat(moodboard): notas, resumen y participantes`.

### Task 4: Campana para una lista de usuarios

**Files:**
- Modify: `src/modules/notifications/application/notification.port.ts`, `infrastructure/prisma-notification.repository.ts`, `infrastructure/notification.port.fake.ts`, `infrastructure/notification.repository.fake.ts`, `infrastructure/notification.repository.paridad.test.ts`
- Modify: `src/modules/notifications/application/realtime.port.ts` (re-exporta `NOTIFICACION_CREADA` para que otros módulos no importen `notifications/domain`)

**Interfaces:**
- Produces:
  - `NotificationPort.crearParaUsuarios(eventId: string, userIds: string[], tipo: string, payload: unknown): Promise<void>` — una fila por `userId` (sin duplicados, `[]` no hace nada), con `clienteDe(prisma)`.
  - `export const TIPOS_MOODBOARD = ['moodboard.image.shared', 'moodboard.note.added'] as const` en `notification.port.ts`.
  - `export { NOTIFICACION_CREADA } from '../domain/notification'` en `realtime.port.ts`.
- `visiblesDe(userId)` gana una tercera rama: `type in TIPOS_MOODBOARD` y el usuario es miembro ACTIVE **o** proveedor BOOKED del evento ACTIVE (la visibilidad de la foto concreta la vuelve a comprobar el REST al abrirla).

- [ ] **Step 1: Paridad:**
  - `crearParaUsuarios(e, [proveedor, miembro], 'moodboard.note.added', …)` → los dos la listan;
  - el proveedor sigue SIN ver `crearParaMiembros` de otros tipos;
  - con la contratación CANCELLED deja de ver la de moodboard;
  - `[]` no crea nada.
- [ ] **Step 2:** FAIL → implementar → PASS. Gate. Commit `feat(notifications): avisos de campana para una lista de usuarios`.

### Task 5: Presencia

**Files:**
- Create: `src/modules/notifications/application/presence.port.ts`
- Create: `src/modules/notifications/infrastructure/redis-presence.adapter.ts`, `presence.fake.ts`, `presence.paridad.test.ts` (doble vs Redis en Testcontainers)
- Modify: `src/modules/notifications/interfaces/notifications.gateway.ts` (+ su test), `application/salas.ts` (docblock), `notifications.module.ts` (provee y **exporta** `PRESENCE_PORT`)
- Modify: `src/modules/events/application/event.repository.ts`, su doble, `prisma-event.repository.ts` y la paridad de eventos (si existe; si no, test de integración): `listarParticipaciones`
- Test: `test/e2e/realtime.e2e.test.ts` (casos nuevos)

**Interfaces:**
- Produces (`presence.port.ts`):

```ts
export interface PresencePort {
  /** Registra el socket. true si el usuario NO estaba anunciado en línea (hay que emitir online). */
  conectar(userId: string, socketId: string, ahora: Date): Promise<boolean>
  /** Renueva la caducidad de esos sockets (latido). */
  renovar(sockets: { userId: string; socketId: string }[], ahora: Date): Promise<void>
  desconectar(userId: string, socketId: string): Promise<void>
  /** Tras la gracia: true si ya no tiene sockets vivos y estaba anunciado (hay que emitir offline). */
  confirmarSalida(userId: string, ahora: Date): Promise<boolean>
  enLinea(userIds: string[], ahora: Date): Promise<Set<string>>
}
export const PRESENCE_PORT = Symbol('PRESENCE_PORT')
export const TTL_SOCKET_MS = 75_000
export const LATIDO_MS = 30_000
export const GRACIA_MS = 20_000
export const EVENTO_PRESENCIA = 'presence.changed'
```

- Redis (*mecánica*):
  - `ZSET presence:sockets:<userId>`, con miembro `socketId` y score `ahora + TTL`. "Vivo" = score > ahora; se purgan los caducados con `ZREMRANGEBYSCORE`.
  - Clave `presence:announced:<userId>`: `conectar` hace `SET NX` y devuelve si la creó; `confirmarSalida` purga, y si `ZCARD = 0` hace `DEL announced` y devuelve si borró 1.
  - Si un proceso muere, sus sockets caducan solos a los 75 s. No se emite offline, pero `enLinea` ya responde bien (hueco aceptado, docblock).
- Produces (`EventRepository`): `listarParticipaciones(userId: string): Promise<{ eventId: string; comoProveedor: boolean }[]>` — membresías ACTIVE (`false`) y contrataciones BOOKED de su ficha en eventos ACTIVE (`true`); un evento sale una vez, y si es ambas cosas gana `false`.
- Gateway:
  - `handleConnection` → `conectar`; si devuelve true, emite `presence.changed { userId, online: true }`.
  - `handleDisconnect` (nuevo, `OnGatewayDisconnect`) → `desconectar` y `setTimeout(GRACIA_MS)` → `confirmarSalida`; si true, emite `{ online: false }`.
  - Un `setInterval(LATIDO_MS)` en `afterInit` renueva los sockets de **este** proceso; se limpia en `onModuleDestroy`.
  - Emisión de presencia a cada participación:
    - miembro → `salaDeEvento` + `salaDeVendorsDeEvento`;
    - proveedor → sólo `salaDeEvento`.
  - Se emite con `this.server.to(sala).emit(...)`, que el adapter de Redis propaga.
- `salas.ts` y docblock del gateway: `event:<id>` ya no es "sólo invitados" (moodboard y presencia) y `event:<id>:vendors` lleva presencia de miembros.

- [ ] **Step 1: Paridad presencia** (doble vs Redis):
  - primera conexión → true, segunda del mismo usuario → false;
  - desconectar uno de dos sockets + `confirmarSalida` → false;
  - desconectar el último → true y luego `enLinea` sin él;
  - reconectar antes de `confirmarSalida` → `conectar` false y `confirmarSalida` false (Review Focus 4);
  - un socket sin latido con `ahora + 76 s` → `enLinea` no lo cuenta.
- [ ] **Step 2: E2E** (`realtime.e2e.test.ts`):
  - el proveedor se une a su sala de evento y la pareja conecta → el proveedor recibe `presence.changed { userId: pareja, online: true }`;
  - la pareja se une, el proveedor conecta → la pareja lo recibe;
  - otro proveedor del mismo evento NO recibe la presencia del primero (espera acotada de 1,5 s sin evento);
  - con `GRACIA_MS` acortada por inyección (parámetro del gateway o token `PRESENCIA_GRACIA_MS` sólo para tests), desconectar → `online: false`.
- [ ] **Step 3:** FAIL → implementar → PASS. `npm test -- test/e2e/realtime.e2e.test.ts src/modules/notifications`. Gate. Commit `feat(notifications): presencia en línea sobre Redis`.

### Task 6: Casos de uso

**Files:**
- Create: `src/modules/moodboard/application/avisos-moodboard.ts`, `moodboard.use-cases.ts` (o un fichero por caso de uso, como `schedule`), `moodboard.use-cases.test.ts`
- Modify: `src/modules/queue/application/queue.port.ts` (`QueueName` + `'moodboard'`)

**Interfaces:**
- Consumes: `MOODBOARD_REPOSITORY` (Tasks 2–3), `SubidaDeImagenes` (`storage`), `NOTIFICATION_PORT.crearParaUsuarios` (Task 4), `PRESENCE_PORT.enLinea` (Task 5), `UnidadDeTrabajo`, `QUEUE_PORT`.
- Produces (`avisos-moodboard.ts`):
  - `COLA_MOODBOARD = 'moodboard'`.
  - Nombres de job/evento: `EVENTO_IMAGEN_CAMBIADA = 'moodboard.image.changed'`, `EVENTO_IMAGEN_OCULTA = 'moodboard.image.hidden'`, `EVENTO_NOTA_CREADA = 'moodboard.note.created'`.
  - Jobs:
    - `JobImagenCambiada { eventId: string; imageId: string; ocultarA: string[]; campanaA: string[]; tipoCampana: 'moodboard.image.shared' | null }`;
    - `JobNotaCreada { eventId: string; imageId: string; noteId: string; campanaA: string[] }`.
  - `encolarAvisoImagen(cola, registro, job)` y `encolarAvisoNota(...)` registran sin propagar.
  - jobIds: `moodboard-img-<imageId>-<epochMs>` y `moodboard-note-<noteId>`.
- Produces (casos de uso; `Visor` de Task 1):
  - `PrepararSubidaUseCase.ejecutar(eventId, contentType: string, bytes: number): Promise<SubidaPreparada>`
  - `CrearImagenUseCase.ejecutar(eventId, userId, datos: { key; title; categoryId; width; height }): Promise<ImagenDeMoodboard>` — en `UnidadDeTrabajo`: `bloquearYContar` → `exigirCupo` → `categoriaActiva` (si no, `CategoriaInvalidaError`) → `confirmar(prefijo, key)` → `crearImagen`; tras el commit, encola `image.changed`.
  - `ListarImagenesUseCase.ejecutar(eventId, visor, archivadas: boolean)`; `ObtenerImagenUseCase.ejecutar(eventId, imageId, visor)` → `ImagenNoEncontradaError` si null.
  - `ArchivarImagenUseCase.ejecutar(eventId, imageId, userId, archivada: boolean)` — idempotente; al archivar, `ocultarA = proveedoresQueVen` **antes** del cambio.
  - `CompartirImagenUseCase.ejecutar(eventId, imageId, userId, eventVendorIds: string[])` — exige foto activa; ids fuera de `listarCompartibles` → `ProveedorNoCompartibleError(ids)`; en `UnidadDeTrabajo` `fijarComparticion` + `crearParaUsuarios(eventId, usuariosDeContrataciones(altas), 'moodboard.image.shared', { imageId })`. `ocultarA` = usuarios de `bajas` que ya no ven la foto por otra contratación (`proveedoresQueVen` después del cambio).
  - `ListarNotasUseCase.ejecutar(eventId, imageId, visor)` y `CrearNotaUseCase.ejecutar(eventId, imageId, visor, body)` — buscan con el visor (404), `exigirActiva`, `normalizarNota`; en `UnidadDeTrabajo` `crearNota` + `crearParaUsuarios(eventId, participantes(imageId, autor), 'moodboard.note.added', { imageId, noteId })`.
  - `ResumenUseCase.ejecutar(eventId, visor): Promise<ResumenCrudo & { online: Set<string> }>` — `enLinea` de los colaboradores.
  - `ListarCompartiblesUseCase.ejecutar(eventId)`.

- [ ] **Step 1: Tests unitarios** contra los fakes:
  - subir con cupo lleno → `MOODBOARD_IMAGE_LIMIT`;
  - categoría inactiva → `MOODBOARD_INVALID_CATEGORY`;
  - key de otro prefijo → `INVALID_UPLOAD`;
  - proveedor pide foto no compartida → `MOODBOARD_IMAGE_NOT_FOUND`;
  - nota en archivada → `MOODBOARD_IMAGE_ARCHIVED`;
  - compartir con SHORTLISTED → 422 con `details.eventVendorIds`;
  - revocar y re-compartir → la campana `moodboard.image.shared` se crea las dos veces (Review Focus 3);
  - nota → campana a participantes sin el autor ni el proveedor revocado (Review Focus 5);
  - archivar → job con `ocultarA` = proveedores que la veían;
  - compartir con `[]` desde `[a]` → `ocultarA` = usuario de `a`;
  - un fallo de cola no tumba la operación.
- [ ] **Step 2:** FAIL → implementar → PASS. Gate. Commit `feat(moodboard): casos de uso`.

### Task 7: HTTP, worker y cableado

**Files:**
- Create: `src/modules/moodboard/interfaces/moodboard.controller.ts`, `moodboard.dto.ts`, `moodboard.json.ts`, `moodboard.processor.ts`, `moodboard.processor.test.ts`, `src/modules/moodboard/moodboard.module.ts`
- Modify: `src/app.module.ts`, `src/modules/storage/storage.module.ts` (sólo si no exporta ya `SubidaDeImagenes`), `src/shared/http/limitadores.ts` (limitador `moodboard-notes`: 30/min por IP vía `@LimiteDeRuta`)

**Interfaces:**
- Consumes: todo lo anterior; `RequireEventAccess`, `EventAccessOf`, `CurrentUser`, `idDeRuta`, `validarCon`.
- `visorDe(acceso: EventAccess | undefined, userId: string): Visor` en `moodboard.json.ts` o un `visor.ts` de `interfaces/` (no en `domain/`: no puede importar `events/domain`). `vendor` → proveedor; `member`/`admin` → miembro.
- DTO Zod:
  - `uploadUrlSchema { contentType: string, bytes: int > 0 }`;
  - `crearImagenSchema { key: string min 1, title: string, categoryId: z.guid(), width/height: int 1..20000 }`;
  - `archivarSchema { archived: boolean }`;
  - `compartirSchema { eventVendorIds: z.array(z.guid()).max(50) }` + refine sin repetidos;
  - `notaSchema { body: string }`;
  - query `archived` = `'true' | 'false'` opcional.
- JSON (`moodboard.json.ts`):
  - `imagenJson(imagen, url, esMiembro)` omite `sharedWith` si `!esMiembro`;
  - `url` con `SubidaDeImagenes.firmarLectura(storageKey)`;
  - avatar con la misma firma que usa `users` para `avatarKey`.
- Worker `MoodboardProcessor` (cola `moodboard`): valida el job con Zod (`satisfies`), re-lee estado:
  - `image.changed` → `emitirAEvento` + `emitirAUsuario` a cada `proveedoresQueVen(imageId)`, `image.hidden` a cada `ocultarA` que **aún** no la ve, y `NOTIFICACION_CREADA { eventId, type }` a cada `campanaA`;
  - `note.created` → igual con `participantes`/`proveedoresQueVen` re-leídos.
- `MoodboardModule` importa `AuthModule`, `UsersModule`, `EventsModule`, `NotificationsModule`, `StorageModule`, `BullModule.registerQueue({ name: COLA_MOODBOARD })`.

- [ ] **Step 1:** Test del processor (fakes de repo y realtime): payload roto → `UnrecoverableError`; un proveedor en `ocultarA` que vuelve a verla por otra contratación no recibe `hidden`; el revocado no recibe `note.created`.
- [ ] **Step 2:** FAIL → implementar controlador, DTO, JSON, processor y módulo → PASS. `npm run build && npm run test:smoke` (alias de la ruta nueva). Gate. Commit `feat(moodboard): API HTTP y worker de avisos`.

### Task 8: E2E de la matriz de acceso

**Files:**
- Create: `test/e2e/moodboard.e2e.test.ts`

Fixture como `messaging.e2e.test.ts`:
- usuarios: creador (PLANNER, owner), pareja no creadora (COUPLE), planner no creador (PLANNER), proveedor A con **dos** contrataciones BOOKED (Decor & Floral y Venue), proveedor B BOOKED, proveedor C SHORTLISTED, extraño y admin;
- `MAIL_DRIVER`/storage con `ObjectStorageFake` (como los e2e de avatar/portfolio).

- [ ] **Step 1: Escribir los tests:**
  - **Matriz** con `it.each` sobre las 10 rutas × {creador, pareja, planner, proveedor con foto compartida, proveedor sin foto compartida, extraño}. Códigos esperados según spec §4: M → 201/200 para miembros, 403 proveedores, 404 extraño; T → proveedor sin compartir: lista `[]`, `GET /images/:id` 404, notas 404.
  - Proveedor A ve fotos compartidas con cualquiera de sus dos contrataciones; no recibe `sharedWith`; `?archived=true` → 403.
  - Compartir con C (SHORTLISTED) → 422 `MOODBOARD_VENDOR_NOT_SHAREABLE`.
  - Revocar a A → A recibe 404 en la foto y en sus notas; re-compartir → recupera notas antiguas y tiene 2 `moodboard.image.shared` en `GET /me/notifications`.
  - Nota de B en foto compartida con A y B → A la lee con autor B; A tiene `moodboard.note.added`; B no.
  - Archivar → los proveedores 404; nota en archivada → 422; recuperar → vuelve.
  - Socket:
    - con A unido a su sala, compartir una foto con A → A recibe `moodboard.image.changed` y `notification.created`;
    - revocar → `moodboard.image.hidden`;
    - B no recibe nada de fotos no compartidas con él (espera acotada).
  - Resumen:
    - miembro ve a A una vez con label `'Decor & Floral · Venue'`;
    - A no ve a B en colaboradores;
    - `online` true para quien tiene socket abierto.
- [ ] **Step 2:** `npx vitest run test/e2e/moodboard.e2e.test.ts` → PASS (los fallos que no sean de test se corrigen en la tarea dueña, con su test).
- [ ] **Step 3:** Suite completa `npm test`, `npm run typecheck`, `npm run lint`, `npx prettier --check .`, `npm run build && npm run test:smoke`. Commit `test(moodboard): e2e de la matriz de acceso y tiempo real`.
