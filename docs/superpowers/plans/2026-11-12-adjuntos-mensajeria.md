# Adjuntos en la mensajería — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un archivo (JPG/PNG/WebP/PDF ≤ 10 MB) por mensaje en las conversaciones de evento, y que quien tiene `BUDGET_EDIT` lo convierta en factura de un gasto nuevo o existente desde el chat; se retira la maqueta de planning.

**Architecture:** Backend: cuatro columnas `attachment*` en `Message`; `storage` gana `copiar` y `SubidaDeAdjuntos`; `messaging` añade subida/envío/descarga y exporta un puerto público `ADJUNTOS_DE_MENSAJES` que `expenses` usa en una ruta `invoice-from-message` que copia el objeto a `events/<id>/invoices` y devuelve la key para el `POST`/`PATCH` de gastos de siempre. Frontend: compositor y burbuja con adjunto, y acciones de factura que reutilizan `ExpenseFormModal`.

**Tech Stack:** NestJS 11, Prisma 6/PostgreSQL 16, Zod, BullMQ, Socket.IO, R2 (S3 SDK), Vitest + Testcontainers; React 19, zustand, zod, Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-12-adjuntos-mensajeria-design.md` (léelo entero antes de cualquier tarea).

**Repos:** backend `/Users/samueltovar/Documents/GitHub/wedding-planner-backend` (Tareas 1–8), frontend `/Users/samueltovar/Documents/GitHub/wedding-planner-frontend` (Tareas 9–13). Rama `feat/planning` ya creada en los dos. Lee el `CLAUDE.md` de cada repo antes de su primera tarea.

## Global Constraints

- Tipos admitidos: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`; tamaño `1 … 10 * 1024 * 1024` bytes (las reglas de factura existentes, `archivoDeFacturaValido`).
- Adjuntos sólo en `EVENT_DIRECT` y `EVENT_ROOM`; en `PROFILE` → 422.
- Un adjunto por mensaje; con adjunto el cuerpo recortado tiene 0–2000 caracteres, sin adjunto 1–2000.
- Nombre del adjunto: 1–200 caracteres tras recortar, sin `/` ni `\`.
- Prefijo de adjuntos: `events/<eventId>/messages/<conversationId>`; prefijo de facturas existente: `events/<eventId>/invoices`.
- Convertir en factura exige `BUDGET_EDIT` **y** ver el mensaje; sin acceso al evento 404, sin `BUDGET_EDIT` 403, mensaje no visible/inexistente/sin adjunto/de otro evento 404.
- "Ver el mensaje" = la regla de `GET /conversations/:id/messages` (en la sala: miembros de hoy ven todo; quien salió, hasta `visibleHasta`). `MessageRecipient` no filtra.
- El JSON de un mensaje nunca lleva la key ni una URL: `attachment: { name, contentType, bytes } | null`.
- Convertir no emite nada a la conversación ni crea campana.
- Códigos de error nuevos: `INVALID_ATTACHMENT` (tipo/tamaño), `INVALID_ATTACHMENT_NAME`, `ATTACHMENTS_NOT_ALLOWED` (PROFILE), `MESSAGE_NOT_FOUND` (convertir).
- Copia UI en inglés; comentarios, docblocks y nombres de test en español; Prettier sin `;`, comillas simples, ancho 100.
- Frontend: tokens con variables CSS, sin `dark:`, iconos con `createIcon` en el `*-icons.tsx` del feature, cero valores arbitrarios, las `*-screen.tsx` sólo ensamblan, DESIGN-GAP documentados.
- Cada commit termina con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Gates por tarea: backend `npm run typecheck && npm run lint && npx prettier --check .` más los tests tocados; frontend `npm run typecheck && npm run lint` más los tests tocados.

## Review Focus

1. **Mensaje sólo con adjunto en las vistas previas**: la bandeja (`inbox.tsx:148`, `:275`) pinta `lastMessage.body`, que será `''`. Esperado: "Attachment: <name>". Test en Tarea 10.
2. **El envío falla tras subir el archivo** (PUT ok, `POST /messages` 4xx/5xx): el texto y el archivo elegido se conservan y "Send" reintenta (vuelve a preparar y subir). Test en Tarea 11.
3. **Quien salió de la sala pide el adjunto de un mensaje posterior a su salida**: 404, igual que el listado. Test en Tarea 5 (unitario) y Tarea 8 (e2e).
4. **El adjunto viaja por socket al proveedor**: el payload de `message.created` no lleva `key` ni URL. Test en Tarea 8.
5. **Nombre de archivo de más de 200 caracteres o con caracteres no latinos**: el frontend lo recorta conservando la extensión (`invoiceFileName`) antes de enviarlo; el backend acepta unicode y rechaza > 200 con 422 `INVALID_ATTACHMENT_NAME`. Tests en Tareas 3 y 11.

---

## Backend

### Task 1: `storage` — copiar y subida de adjuntos

**Files:**
- Modify: `src/modules/storage/application/object-storage.port.ts`, `src/modules/storage/infrastructure/r2-object-storage.ts`, `src/modules/storage/infrastructure/object-storage.fake.ts`, `src/modules/storage/infrastructure/sin-almacenamiento.ts`, `src/modules/storage/application/subida-de-facturas.ts`, `src/modules/storage/storage.module.ts`
- Create: `src/modules/storage/domain/archivo-adjunto.ts`, `src/modules/storage/application/subida-de-adjuntos.ts`
- Test: `src/modules/storage/application/subida-de-adjuntos.test.ts`, `src/modules/storage/application/subida-de-facturas.test.ts`

**Interfaces:**
- Produces:
  - `ObjectStorage.copiar(origen: string, destino: string): Promise<void>` (R2: `CopyObjectCommand` con `CopySource: \`${bucket}/${origen}\``; fake: copia la entrada del `Map`; `SinAlmacenamiento`: rechaza con `AlmacenamientoNoDisponibleError`).
  - `ArchivoAdjuntoInvalidoError` (422, `INVALID_ATTACHMENT`, mensaje "El adjunto debe ser un PDF, JPG, PNG o WebP de hasta 10 MB").
  - `SubidaDeAdjuntos` (`@Injectable`, exportada por `StorageModule`): `preparar(prefijo, contentType, bytes): Promise<SubidaPreparada>`, `confirmar(prefijo, key): Promise<{ contentType: string; bytes: number }>`, `firmarLectura(key, nombre): Promise<string | null>`. Reglas = las de factura (`TIPOS_DE_FACTURA`, `archivoDeFacturaValido`) con `errorDeTipo: () => new ArchivoAdjuntoInvalidoError()`.
  - `SubidaDeFacturas.copiarDesde(origen: string, prefijo: string, contentType: string): Promise<string>` → nueva key `${prefijo}/${randomUUID()}.${TIPOS_DE_FACTURA[contentType]}`; lanza `AlmacenamientoNoDisponibleError` sin almacén y `ArchivoDeFacturaInvalidoError` si el tipo no es de factura.

- [ ] **Step 1: Tests que fallan.** En `subida-de-adjuntos.test.ts` (con `ObjectStorageEnMemoria`): `preparar('events/e/messages/c', 'application/pdf', 1024)` devuelve key con prefijo y `.pdf`; `preparar(..., 'image/gif', 10)` y `preparar(..., 'application/pdf', 10 * 1024 * 1024 + 1)` lanzan `ArchivoAdjuntoInvalidoError` (code `INVALID_ATTACHMENT`); `confirmar` de un objeto subido como `text/plain` lanza y lo borra (`almacen.borradas` lo contiene). En `subida-de-facturas.test.ts`: `copiarDesde('events/e/messages/c/x.pdf', 'events/e/invoices', 'application/pdf')` devuelve key `events/e/invoices/<uuid>.pdf` y `almacen.objetos` tiene origen y destino con el mismo `{ contentType, bytes }`.
- [ ] **Step 2:** `npx vitest run src/modules/storage` → FAIL (no existen).
- [ ] **Step 3:** Implementar lo de **Interfaces**. Docblock de `SubidaDeAdjuntos`: por qué no reutiliza `SubidaDeFacturas` (spec §7).
- [ ] **Step 4:** `npx vitest run src/modules/storage` → PASS; gates backend.
- [ ] **Step 5: Commit** `feat(storage): copiar objetos y subida directa de adjuntos de mensajería`.

### Task 2: Esquema y migración de `Message`

**Files:**
- Modify: `prisma/schema.prisma` (`model Message`), `docs/DATABASE.md` (sección de `messages`)
- Create: `prisma/migrations/20261112120000_adjuntos_mensajeria/migration.sql`
- Test: `src/modules/messaging/infrastructure/mensajes-restricciones.test.ts`

**Interfaces:**
- Produces: columnas `attachmentKey String? @unique`, `attachmentName String?`, `attachmentType String?`, `attachmentBytes Int?`; CHECK `messages_adjunto_completo`, `messages_adjunto_bytes` (`"attachmentBytes" IS NULL OR "attachmentBytes" > 0`), y `messages_cuerpo_longitud` sustituido por: `char_length(btrim(body)) BETWEEN (CASE WHEN "attachmentKey" IS NULL THEN 1 ELSE 0 END) AND 2000`.

- [ ] **Step 1: Test que falla** (Testcontainers con `startPostgres`, como `expenses-restricciones.test.ts`), insertando con Prisma sobre una conversación sembrada: acepta `body: ''` con las cuatro columnas; rechaza `body: ''` sin adjunto; rechaza sólo `attachmentKey` (adjunto incompleto); rechaza `attachmentBytes: 0`; rechaza dos mensajes con la misma `attachmentKey` (P2002). Cada rechazo comprueba el nombre del constraint en el error.
- [ ] **Step 2:** `npx vitest run src/modules/messaging/infrastructure/mensajes-restricciones.test.ts` → FAIL.
- [ ] **Step 3:** Editar el schema, generar la migración (`npx prisma migrate dev --create-only --name adjuntos_mensajeria`, renombrar la carpeta a la fecha de arriba si hace falta) y añadir a mano los CHECK (`DROP CONSTRAINT messages_cuerpo_longitud` + los tres nuevos) con comentario SQL como el de `20261029120000_mensajeria_base`. Documentar columnas y CHECK en `docs/DATABASE.md` y que "la conversación no es PROFILE" lo valida el caso de uso.
- [ ] **Step 4:** el test → PASS; `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <pg de test>` sin diferencias (o el comando exacto de CI del README §Comprobaciones); gates.
- [ ] **Step 5: Commit** `feat(messaging): columnas de adjunto en messages con sus CHECK`.

### Task 3: Dominio de mensajería — cuerpo y nombre del adjunto

**Files:**
- Modify: `src/modules/messaging/domain/conversacion.ts`, `src/modules/messaging/domain/messaging-errors.ts`
- Test: `src/modules/messaging/domain/conversacion.test.ts`

**Interfaces:**
- Produces:
  - `normalizarCuerpo(texto: string, conAdjunto = false): string` — con adjunto admite `''`; tope 2000 igual.
  - `MAX_NOMBRE_ADJUNTO = 200`; `normalizarNombreDeAdjunto(nombre: string): string` — recorta; vacío, > 200 (contando con `Array.from`), o con `/` o `\` → `NombreDeAdjuntoInvalidoError` (422, `INVALID_ATTACHMENT_NAME`).
  - `AdjuntosNoPermitidosError` (422, `ATTACHMENTS_NOT_ALLOWED`).

- [ ] **Step 1: Tests que fallan:** `normalizarCuerpo('  ', true) === ''`; `normalizarCuerpo('  ')` lanza `MensajeInvalidoError`; `normalizarCuerpo('x'.repeat(2001), true)` lanza; `normalizarNombreDeAdjunto(' factura.pdf ') === 'factura.pdf'`; `normalizarNombreDeAdjunto('факту́ра 📎.pdf')` se acepta; `'a'.repeat(201)`, `''`, `'../x.pdf'`, `'a\\b.pdf'` lanzan con code `INVALID_ATTACHMENT_NAME`.
- [ ] **Step 2:** `npx vitest run src/modules/messaging/domain` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** PASS; gates.
- [ ] **Step 5: Commit** `feat(messaging): reglas de dominio del cuerpo y el nombre de un adjunto`.

### Task 4: Repositorio de conversaciones con adjuntos (puerto, fake, Prisma, paridad)

**Files:**
- Modify: `src/modules/messaging/application/conversation.repository.ts`, `src/modules/messaging/infrastructure/conversation.repository.fake.ts`, `src/modules/messaging/infrastructure/prisma-conversation.repository.ts`, y los llamadores de `agregarMensaje`/`agregarMensajeDeSala`/`solicitar` que dejen de compilar
- Test: `src/modules/messaging/infrastructure/conversation.repository.paridad.test.ts`, `src/modules/messaging/infrastructure/prisma-conversation.repository.test.ts`

**Interfaces:**
- Produces (en `conversation.repository.ts`):
  - `interface AdjuntoVista { name: string; contentType: string; bytes: number }`
  - `interface AdjuntoGuardado extends AdjuntoVista { key: string }`
  - `MensajeVista.attachment: AdjuntoVista | null` (todas las lecturas lo rellenan: `mensajes`, `mensaje`, `lastMessage` de bandeja/salas/perfiles).
  - `agregarMensaje(conversationId, senderId, body, ahora, adjunto: AdjuntoGuardado | null): Promise<MensajeVista>` y `agregarMensajeDeSala(..., adjunto: AdjuntoGuardado | null)` — parámetro nuevo al final, obligatorio.
  - `interface AdjuntoDeMensaje extends AdjuntoGuardado { messageId: string; conversationId: string; eventId: string | null; senderId: string; createdAt: Date }`
  - `adjuntoDe(messageId: string): Promise<AdjuntoDeMensaje | null>` — `null` si no existe o no tiene adjunto.

- [ ] **Step 1: Casos de paridad que fallan** (mismo caso contra fake y Prisma, `sinVolatiles`): mensaje 1:1 con adjunto aparece en `mensajes` y en `lastMessage` de `bandeja` con `attachment` y sin key; mensaje de sala con adjunto en `mensajes` y `salas`; `adjuntoDe` devuelve key, `eventId` y `senderId`; `adjuntoDe` de un mensaje sin adjunto y de un id inexistente → `null`.
- [ ] **Step 2:** `npx vitest run src/modules/messaging/infrastructure` → FAIL.
- [ ] **Step 3:** Implementar en fake y Prisma (`select` de las cuatro columnas; `attachment` es `null` si `attachmentKey` es null).
- [ ] **Step 4:** PASS; `npx vitest run src/modules/messaging` entero en verde; gates.
- [ ] **Step 5: Commit** `feat(messaging): el repositorio guarda y lee el adjunto de un mensaje`.

### Task 5: Casos de uso de adjuntos y puerto público `ADJUNTOS_DE_MENSAJES`

**Files:**
- Create: `src/modules/messaging/application/adjuntos-de-mensajes.port.ts`, `src/modules/messaging/application/adjuntos.use-cases.ts`, `src/modules/messaging/infrastructure/adjuntos-de-mensajes.fake.ts`
- Modify: `src/modules/messaging/application/send-message.use-case.ts`, `src/modules/messaging/messaging.module.ts`
- Test: `src/modules/messaging/application/adjuntos.use-cases.test.ts`, `src/modules/messaging/application/messaging.use-cases.test.ts`

**Interfaces:**
- Consumes: Tarea 1 (`SubidaDeAdjuntos`, `ObjectStorageEnMemoria`), Tarea 3, Tarea 4.
- Produces:
  - `adjuntos-de-mensajes.port.ts`: `interface AdjuntoVisible { messageId: string; eventId: string; conversationId: string; senderId: string; key: string; name: string; contentType: string; bytes: number }`; `interface AdjuntosDeMensajes { buscarVisible(userId: string, messageId: string): Promise<AdjuntoVisible | null> }`; `export const ADJUNTOS_DE_MENSAJES = Symbol('ADJUNTOS_DE_MENSAJES')`.
  - `adjuntos.use-cases.ts`:
    - `prefijoAdjuntos(eventId: string, conversationId: string): string` → `events/${eventId}/messages/${conversationId}`.
    - `BuscarAdjuntoVisible implements AdjuntosDeMensajes` — `adjuntoDe` → `localizarConversacion(repo, conversationId, userId)`; `null` si no la ve, si es `perfil`, o si es sala `readOnly` y el mensaje queda después de `visibleHasta` (misma comparación que usa `mensajes(..., { hasta })`; usar `alcanza` de `domain/conversacion.ts`).
    - `PrepararSubidaAdjuntoUseCase.ejecutar(userId, conversationId, contentType, bytes): Promise<SubidaPreparada>` — no la ve → `ConversacionNoEncontradaError`; `perfil` → `AdjuntosNoPermitidosError`; `readOnly` → `ConversacionSoloLecturaError`.
    - `DescargarAdjuntoUseCase.ejecutar(userId, conversationId, messageId): Promise<{ url: string }>` — `buscarVisible`; `null` o `conversationId` distinto → `ConversacionNoEncontradaError` (404); `firmarLectura(key, name)` `null` → `AlmacenamientoNoDisponibleError`.
  - `SendMessageUseCase.ejecutar(userId, conversationId, texto: string, adjunto: { key: string; name: string } | null)` — con adjunto: `perfil` → `AdjuntosNoPermitidosError`; `normalizarNombreDeAdjunto`; `subidas.confirmar(prefijoAdjuntos(eventId, conversationId), key)` antes de guardar; `normalizarCuerpo(texto, adjunto !== null)`.
  - `AdjuntosDeMensajesEnMemoria implements AdjuntosDeMensajes` con `poner(userId: string, adjunto: AdjuntoVisible): void`.
  - `MessagingModule`: importa `StorageModule`; provee los tres casos de uso y `{ provide: ADJUNTOS_DE_MENSAJES, useExisting: BuscarAdjuntoVisible }`; `exports: [ADJUNTOS_DE_MENSAJES]`. Actualizar su docblock.

- [ ] **Step 1: Tests que fallan** (fake de repositorio + `ObjectStorageEnMemoria` + doble de cola existente): enviar con adjunto subido en 1:1 y en sala guarda `attachment` y `body: ''`; enviar con key de otro prefijo → 422 `UPLOAD_INVALID` (el error de `SubidaNoValidaError`, verifica su code real); enviar con adjunto en `PROFILE` → `ATTACHMENTS_NOT_ALLOWED`; `PrepararSubidaAdjunto` en `PROFILE` → 422, no participante → 404, sala `readOnly` → 403; `buscarVisible`: participante lo ve, no participante `null`, miembro que entró en la sala después del mensaje lo ve, quien salió antes del mensaje `null`; `DescargarAdjunto` con `conversationId` ajeno → 404 y feliz → URL con `?as=<nombre>`.
- [ ] **Step 2:** `npx vitest run src/modules/messaging/application` → FAIL.
- [ ] **Step 3:** Implementar; docblocks con la regla de visibilidad (spec §5) y la alternativa descartada (filtrar por destinatarios).
- [ ] **Step 4:** PASS; gates (incluye `npm run lint:arch`).
- [ ] **Step 5: Commit** `feat(messaging): subir, enviar y descargar adjuntos; puerto público para leerlos`.

### Task 6: Rutas HTTP y JSON de adjuntos

**Files:**
- Modify: `src/modules/messaging/interfaces/messaging.dto.ts`, `src/modules/messaging/interfaces/messaging.json.ts`, `src/modules/messaging/interfaces/conversations.controller.ts`, `src/shared/http/limitadores.ts`
- Test: `src/modules/messaging/interfaces/messaging.dto.test.ts` (crear si no existe), `src/modules/messaging/interfaces/messaging.processor.test.ts`

**Interfaces:**
- Consumes: Tarea 5.
- Produces:
  - `enviarMensajeSchema`: `{ body?: string (trim, ≤ 2000, default ''), attachment?: { key: string(1..500), name: string(1..200) } }` con `refine`: `body` no vacío o `attachment` presente.
  - `subidaDeAdjuntoSchema`: `{ contentType: string, bytes: int > 0 }`.
  - `MensajeJson.attachment: { name: string; contentType: string; bytes: number } | null` en `mensajeJson`.
  - Rutas: `POST /conversations/:id/attachment-upload-url` (201, `@LimiteDeRuta(LIMITADOR_ATTACHMENTS, { ttl: 60_000, limit: 20 })`) → `{ key, uploadUrl }`; `GET /conversations/:id/messages/:messageId/attachment` → `{ url }`; `POST /conversations/:id/messages` pasa `attachment ?? null`.
  - `LIMITADOR_ATTACHMENTS = 'attachments'` registrado como los demás limitadores con nombre.

- [ ] **Step 1: Tests que fallan:** el DTO acepta `{ attachment }` sin `body`, rechaza `{}` y `{ body: '  ' }`; `mensajeJson` de un mensaje con adjunto no tiene propiedad `key`; el processor emite `message.created` con `attachment` y sin `key` (en `messaging.processor.test.ts`).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementar; si `test/support/throttler.ts` o un test de limitadores enumera los nombres, añadir `attachments`.
- [ ] **Step 4:** PASS; gates.
- [ ] **Step 5: Commit** `feat(messaging): rutas de subida y descarga de adjuntos`.

### Task 7: `expenses` — factura desde un mensaje

**Files:**
- Modify: `src/modules/expenses/application/expense.repository.ts`, `src/modules/expenses/infrastructure/expense.repository.fake.ts`, `src/modules/expenses/infrastructure/prisma-expense.repository.ts`, `src/modules/expenses/domain/expense.ts`, `src/modules/expenses/domain/expense-errors.ts`, `src/modules/expenses/application/archivos-de-factura.use-cases.ts`, `src/modules/expenses/interfaces/expenses.controller.ts`, `src/modules/expenses/interfaces/expenses.dto.ts`, `src/modules/expenses/expenses.module.ts`
- Test: `src/modules/expenses/domain/expense.test.ts`, `src/modules/expenses/application/expenses.use-cases.test.ts`, `src/modules/expenses/infrastructure/expense.repository.paridad.test.ts`

**Interfaces:**
- Consumes: `ADJUNTOS_DE_MENSAJES` / `AdjuntosDeMensajes` / `AdjuntosDeMensajesEnMemoria` (Tarea 5), `SubidaDeFacturas.copiarDesde` (Tarea 1).
- Produces:
  - `ExpenseRepository.contratacionesConFichaDe(eventId: string, userId: string): Promise<string[]>` — ids de `EventVendor` del evento con `status = BOOKED` y `vendorProfile.userId = userId`.
  - `proveedorSugerido(contrataciones: readonly string[]): string | null` (dominio) — el único id si hay exactamente uno, si no `null`.
  - `MensajeNoEncontradoError` (404, `MESSAGE_NOT_FOUND`).
  - `FacturaDesdeMensajeUseCase.ejecutar(userId, eventId, messageId): Promise<{ key: string; name: string; suggestedEventVendorId: string | null }>` — `buscarVisible`; `null` o `eventId` distinto → `MensajeNoEncontradoError`; `copiarDesde(adjunto.key, prefijoFacturas(eventId), adjunto.contentType)`; `proveedorSugerido(await repo.contratacionesConFichaDe(eventId, adjunto.senderId))`.
  - Ruta `POST /events/:eventId/expenses/invoice-from-message`, `@RequireEventAccess('BUDGET_EDIT')`, cuerpo `{ messageId: z.guid() }`, mismo código de estado que `invoice-upload-url`.
  - `ExpensesModule` importa `MessagingModule`.

- [ ] **Step 1: Tests que fallan:** dominio: `proveedorSugerido([])`, `(['a'])`, `(['a','b'])`. Paridad: `contratacionesConFichaDe` con una BOOKED con ficha del usuario, otra SHORTLISTED, otra CANCELLED, otra de otro usuario y otra de otro evento → sólo la primera; con dos BOOKED del mismo usuario → las dos. Caso de uso (fakes): feliz copia a `events/<e>/invoices/…` con la extensión del tipo y devuelve el nombre original; adjunto de otro evento → `MESSAGE_NOT_FOUND`; no visible → `MESSAGE_NOT_FOUND`; remitente con una contratación → su id, con dos → `null`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementar; docblock del caso de uso con las decisiones 5, 6 y 10 de §13 del spec.
- [ ] **Step 4:** PASS; `npm run lint:arch` limpio (dependencia `expenses → messaging` sólo por el puerto); gates.
- [ ] **Step 5: Commit** `feat(expenses): factura de un gasto a partir del adjunto de un mensaje`.

### Task 8: E2E de adjuntos y matriz de acceso

**Files:**
- Create: `test/e2e/messaging-adjuntos.e2e.test.ts`

**Interfaces:**
- Consumes: todas las rutas de Tareas 6 y 7; patrón de app con `OBJECT_STORAGE` sustituido por `ObjectStorageEnMemoria` de `test/e2e/moodboard.e2e.test.ts:244-290`.

Actores: creador (PLANNER+OWNER, `BUDGET_EDIT`), pareja no creadora, planner invitado no creador, proveedor P contratado (BOOKED con ficha), proveedor Q contratado en el mismo evento, extraño. Helper `keySubida(conversationId, como)` = `attachment-upload-url` + `almacen.simularSubida(key, 'application/pdf', 2048)`.

- [ ] **Step 1: Tests (fallan si algo de lo anterior está mal):**
  - P envía un PDF sin texto en su 1:1 con el creador → 201 con `attachment: { name, contentType: 'application/pdf', bytes: 2048 }`, `body: ''`, sin `key`; el creador lo ve en `GET /messages` y descarga (`GET …/attachment` → `{ url }`).
  - El socket del creador recibe `message.created` con `attachment` y sin `key` ni `url`.
  - Q pide el adjunto del 1:1 de P → 404; el extraño → 404.
  - Sala: pareja envía con adjunto; planner invitado lo descarga; un miembro que entró después también; un miembro revocado antes del mensaje → 404.
  - `PROFILE`: `attachment-upload-url` → 422 `ATTACHMENTS_NOT_ALLOWED`; enviar con `attachment` → 422.
  - Tipo no permitido (`image/gif`) → 422 `INVALID_ATTACHMENT`; nombre de 201 caracteres → 422 `INVALID_ATTACHMENT_NAME`.
  - Creador: `invoice-from-message` → key bajo `events/<id>/invoices/` y `suggestedEventVendorId` = contratación de P; `POST /expenses` con `invoiceFile: { key, name }` crea el gasto PENDING; el socket de P **no** recibe ningún evento de gasto en los 2 s siguientes y `GET /me/vendor-payments` de P no lo lista.
  - Asociar a gasto existente con archivo: nuevo `invoice-from-message` + `PATCH` con `invoiceFile` → el archivo anterior aparece en `almacen.borradas` y el adjunto del mensaje sigue descargable.
  - Pareja y planner invitado: `invoice-from-message` → 403; P y Q → 403 (acceso `vendor` sin `BUDGET_EDIT`); extraño → 404; `messageId` de otro evento → 404 `MESSAGE_NOT_FOUND`.
- [ ] **Step 2:** `npx vitest run test/e2e/messaging-adjuntos.e2e.test.ts` → PASS (si falla, el fallo está en una tarea anterior: arréglalo allí).
- [ ] **Step 3:** Suite completa `npm test`, `npm run build && npm run test:smoke`, gates.
- [ ] **Step 4: Commit** `test(messaging): e2e de adjuntos y factura desde el chat`.
- [ ] **Step 5: PR backend** contra `develop` (`gh pr create --base develop`), cuerpo con resumen, enlace al spec y la línea `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Frontend

### Task 9: Retirar planning

**Files:**
- Delete: `src/features/planning/` entero
- Modify: `design/design-gaps.md` (filas de `planning-tools-screen.tsx:55` y `shared-file-folder.tsx:12`), `CLAUDE.md` (local, gitignorado)

- [ ] **Step 1:** `git rm -r src/features/planning`; quitar la fila de `planning-tools-screen.tsx` y, en la fila compartida con `upcoming-task-item.tsx`, sólo la referencia a `shared-file-folder.tsx`.
- [ ] **Step 2:** `grep -rn "features/planning\|planning-tools" src design` sin resultados; `npm run typecheck && npm run lint && npm test` en verde.
- [ ] **Step 3:** En `CLAUDE.md`: la lista de "pantallas sin ruta" deja de mencionar planning, moodboard y timeline (estos dos ya tienen ruta) y el recuento se ajusta. No se commitea (está en `.gitignore`).
- [ ] **Step 4: Commit** `chore(planning): retirar la maqueta de Planning Tools` con el porqué (spec del backend 2026-11-12 §1) en el cuerpo.

### Task 10: API y modelo de mensajería con adjunto

**Files:**
- Modify: `src/features/messaging/messaging-model.ts`, `src/features/messaging/messaging-api.ts`, `src/features/messaging/inbox.tsx`, `src/features/budget/expenses-api.ts`
- Test: `src/features/messaging/messaging-model.test.ts`, `src/features/messaging/messaging-api.test.ts`, `src/features/budget/expenses-api.test.ts`

**Interfaces:**
- Produces:
  - `adjuntoSchema = z.object({ name: z.string(), contentType: z.string(), bytes: z.number() })`; `mensajeSchema.attachment: adjuntoSchema.nullable()`; `type Adjunto`.
  - `vistaPrevia(m: Mensaje): string` → `m.body` si no está vacío, si no `` `Attachment: ${m.attachment?.name ?? ''}` ``. `inbox.tsx` la usa en las dos vistas previas.
  - `sendMessage(id: string, body: string, attachment?: { key: string; name: string }): Promise<Mensaje>` (sólo manda `attachment` si viene).
  - `prepareAttachmentUpload(id: string, contentType: string, bytes: number): Promise<PreparedUpload>` → `POST /conversations/:id/attachment-upload-url`.
  - `getAttachmentUrl(id: string, messageId: string): Promise<string>`.
  - En `expenses-api.ts`: `invoiceFromMessage(eventId: string, messageId: string): Promise<{ key: string; name: string; suggestedEventVendorId: string | null }>`.

- [ ] **Step 1: Tests que fallan:** el esquema parsea mensaje con `attachment: null` y con adjunto, y rechaza `attachment` sin `name`; `vistaPrevia` de `{ body: '', attachment: { name: 'f.pdf', … } }` → `'Attachment: f.pdf'`; `sendMessage('c-1', '', { key: 'k', name: 'f.pdf' })` hace POST con `{ body: '', attachment: { key: 'k', name: 'f.pdf' } }`; `sendMessage('c-1', 'Hola')` no manda `attachment`; `prepareAttachmentUpload`, `getAttachmentUrl` e `invoiceFromMessage` llaman a sus rutas y validan la respuesta con zod (respuesta malformada rechaza).
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS; gates frontend.
- [ ] **Step 5: Commit** `feat(messaging): modelo y API de adjuntos`.

### Task 11: Store y compositor con adjunto

**Files:**
- Modify: `src/lib/messaging-store.ts`, `src/features/messaging/thread.tsx` (`Composer`), `src/features/messaging/conversation-view.tsx`, `src/features/messaging/room-view.tsx`, `src/features/messaging/profile-view.tsx`, `src/features/messaging/messaging-icons.tsx`
- Test: `src/lib/messaging-store.test.ts`, `src/features/messaging/room-view.test.tsx` o un `thread.test.tsx` nuevo para `Composer`

**Interfaces:**
- Consumes: Tarea 10; `uploadFile` e `invoiceFileProblem`/`INVOICE_TYPES` de `src/lib/upload.ts`; `invoiceFileName` de `features/budget/expenses-api.ts`.
- Produces:
  - Store: `adjuntos: Record<string, File>`, `ponerAdjunto(id: string, file: File | null): void` (vaciado en `clear()`); `enviar(id: string, body: string, archivo?: File): Promise<void>` — con archivo: `prepareAttachmentUpload` → `uploadFile` → `sendMessage(id, body, { key, name: invoiceFileName(archivo.name) })`; mismo manejo de error (toast + rechaza) que hoy.
  - `Composer({ conversationId, permiteAdjuntos }: { conversationId: string; permiteAdjuntos: boolean })` — `true` en `conversation-view` y `room-view`, `false` en `profile-view`.
  - `AttachIcon` (`createIcon(Lucide.Paperclip, 'size-5')`) en `messaging-icons.tsx`.

- [ ] **Step 1: Tests que fallan:**
  - store: `enviar('c', '', file)` llama en orden a preparar, subir y `sendMessage` con el nombre recortado por `invoiceFileName`; si `sendMessage` rechaza, `adjuntos.c` y el borrador siguen ahí; `clear()` vacía `adjuntos`.
  - Composer: con `permiteAdjuntos` hay botón "Attach file" (por rol y nombre); sin él no hay; elegir un `image/gif` muestra "Use a PDF, JPG, PNG or WebP file." y no lo anota; elegir un PDF muestra su nombre y tamaño y un botón "Remove attachment"; "Send" habilitado con sólo adjunto; tras enviar con éxito se vacían borrador y adjunto; si falla, se conservan.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementar. El adjunto elegido vive en el store (mismo porqué que `borradores`: sobrevive a cerrar el panel); `<input type="file">` oculto con `accept={INVOICE_TYPES.join(',')}` como en `invoice-file-field.tsx`. Docblock del `Composer` actualizado.
- [ ] **Step 4:** PASS; gates.
- [ ] **Step 5: Commit** `feat(messaging): adjuntar un archivo al escribir`.

### Task 12: Burbuja con adjunto

**Files:**
- Create: `src/features/messaging/message-attachment.tsx`
- Modify: `src/features/messaging/thread.tsx` (`Hilo`), `src/features/messaging/chat-bubble.tsx` (sólo el docblock/DESIGN-GAP), `src/features/messaging/messaging-icons.tsx`
- Test: `src/features/messaging/message-attachment.test.tsx`

**Interfaces:**
- Consumes: Tarea 10 (`Adjunto`, `getAttachmentUrl`).
- Produces:
  - `MessageAttachment({ conversationId, messageId, attachment, actions }: { conversationId: string; messageId: string; attachment: Adjunto; actions?: ReactNode })` — imagen: miniatura cargada con `getAttachmentUrl` (tamaño acotado con tokens, `alt` = nombre); PDF: `PdfIcon`, nombre y tamaño legible (KB/MB); botón "Download <name>" que pide la URL y la abre; error de URL → toast. `actions` se pinta junto al botón.
  - `Hilo` gana `accionesDeAdjunto?: ((m: MensajeDeSala) => ReactNode) | undefined` y pinta `MessageAttachment` encima de `m.body` cuando `m.attachment !== null` (el cuerpo vacío no deja un párrafo vacío).

- [ ] **Step 1: Tests que fallan:** PDF muestra nombre y "2 KB"; imagen muestra `img` con `alt` = nombre tras resolver la URL; "Download f.pdf" llama a `getAttachmentUrl('c', 'm')` y abre la URL; fallo → toast; `actions` aparece si se pasa.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar; DESIGN-GAP en `message-attachment.tsx` (el export de mensajería no dibuja adjuntos con acciones: qué dice, qué se hace) y actualizar el de `chat-bubble.tsx`.
- [ ] **Step 4:** PASS; gates.
- [ ] **Step 5: Commit** `feat(messaging): adjunto en la burbuja con descarga`.

### Task 13: Factura desde el chat

**Files:**
- Create: `src/features/messaging/use-event-budget.ts`, `src/features/messaging/attachment-invoice-actions.tsx`, `src/features/messaging/attach-to-expense-dialog.tsx`
- Modify: `src/features/budget/expense-form-modal.tsx`, `src/features/budget/invoice-file-field.tsx`, `src/features/messaging/conversation-view.tsx`, `src/features/messaging/room-view.tsx`
- Test: `src/features/messaging/use-event-budget.test.tsx`, `src/features/messaging/attachment-invoice-actions.test.tsx`, `src/features/messaging/attach-to-expense-dialog.test.tsx`, `src/features/budget/expense-form-modal.test.tsx`

**Interfaces:**
- Consumes: `invoiceFromMessage` (Tarea 10), `getEvent` (`features/event-config/event-api.ts`), `listExpenses`/`updateExpense` (`features/budget/expenses-api.ts`), `ConfirmModal`, `DropdownMenu`, `Modal`, `SearchField`, `showToast`.
- Produces:
  - `useEventBudget(eventId: string | null): { canEdit: boolean; currency: string; isOwner: boolean } | null` — `null` mientras carga, sin evento o si falla; `canEdit` = `budgetAccess === 'edit'`.
  - `FileChoice` gana `{ kind: 'prepared'; key: string; name: string }`: el formulario manda `invoiceFile: { key, name }` sin subir nada.
  - `ExpenseFormModalProps.prefill?: { invoiceFile: { key: string; name: string }; eventVendorId: string | null } | undefined` — sólo en alta: arranca con `FileChoice` `prepared`, el campo muestra el nombre, y si `eventVendorId` no es `null` y está en la lista de proveedores del evento, queda preseleccionado en la pestaña Vendor.
  - `AttachmentInvoiceActions({ eventId, messageId, currency, isOwner, onDone })` — `DropdownMenu` con "Create expense" (llama a `invoiceFromMessage` y abre `ExpenseFormModal` con `prefill`, `categories={[]}`) y "Attach to expense" (abre el diálogo).
  - `AttachToExpenseDialog({ eventId, messageId, open, onOpenChange, onDone })` — lista paginada de `listExpenses` con `SearchField` (`q`); al elegir uno con `invoiceFile !== null`, `ConfirmModal` "Replace invoice file?" ("<expense> already has <name>. It will be replaced."); luego `invoiceFromMessage` → `updateExpense(eventId, id, { invoiceFile: { key, name } })` → toast "Invoice attached to <concept>.".
  - `conversation-view.tsx` y `room-view.tsx`: `useEventBudget(vista.event.id)`; con `canEdit` pasan `accionesDeAdjunto` a `Hilo`.

- [ ] **Step 1: Tests que fallan:**
  - hook: `budgetAccess: 'edit'` → `canEdit: true`; `'view'` → `false`; `getEvent` rechaza → `null`.
  - `ExpenseFormModal` con `prefill`: muestra el nombre del archivo; guardar llama a `createExpense` con `invoiceFile: { key, name }` y **no** a `prepareInvoiceUpload`; `eventVendorId` conocido queda seleccionado.
  - acciones: "Create expense" llama a `invoiceFromMessage(eventId, messageId)` y abre el modal "Add expense" con el archivo; error → toast y no abre.
  - diálogo: elegir gasto sin archivo → `updateExpense` sin confirmación; con archivo → aparece "Replace invoice file?" y sólo "Replace" llama a `updateExpense`; "Cancel" no llama a nada.
  - `conversation-view`/`room-view`: con `budgetAccess: 'view'` no aparece el menú de acciones del adjunto; con `'edit'` sí.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementar. DESIGN-GAP en `attachment-invoice-actions.tsx` (el export no tiene este menú). `ExpenseFormModal` no se duplica.
- [ ] **Step 4:** PASS; `npm test` entero; `npm run build`; gates.
- [ ] **Step 5: Commit** `feat(messaging): crear o asociar un gasto desde un adjunto del chat`.
- [ ] **Step 6: PR frontend** contra `develop` (después del backend), enlazando el PR del backend y el spec, con la línea `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
