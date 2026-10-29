# Mensajería parte 1 (backend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conversaciones individuales de evento: abrir, escribir, listar, paginar, marcas de recibido/leído y avisos en tiempo real.

**Architecture:** Módulo nuevo `messaging` (domain / application / infrastructure / interfaces). El acceso para mensajería se expresa como filtro de datos en el repositorio (mismo criterio que `notifications`), probado con paridad. Los avisos de socket salen por una cola propia `messaging` y un worker que re-comprueba la visibilidad por destinatario.

**Tech Stack:** NestJS 11, Prisma 6 / Postgres 16, BullMQ, Socket.IO (adapter Redis existente), Zod, Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-10-29-mensajeria-base-design.md`

## Global Constraints

- Rama `feat/mensajeria-base` (creada desde `develop`). Sin push ni PR. Nunca hacer stage de `.claude/settings.json`.
- Comentarios, docblocks y `describe`/`it` en español (líneas ≤ 100); strings de API en inglés. Prettier: sin `;`, comillas simples, ancho 100.
- Gate por tarea: `npm run typecheck && npm run lint && npx prettier --check .` + tests tocados; `npm test` antes del commit final de cada tarea. CI corre `prisma migrate diff`: todo cambio de `schema.prisma` lleva migración.
- Acceso para mensajería (spec §4.1): miembro `ACTIVE` (pareja o planner; evento publicado o no) **o** proveedor `BOOKED` (vía `VendorProfile.userId`) de un evento `status = 'ACTIVE'`. Admin del sistema no cuenta por serlo. `INVITED` no tiene acceso.
- Pares permitidos: miembro↔miembro, miembro↔proveedor. **Nunca proveedor↔proveedor.**
- Una conversación por (evento, par sin orden) — `pairKey` único. Reabrirla devuelve la existente.
- Visibilidad: participante y (tiene acceso hoy **o** es miembro que lo perdió → solo lectura). Proveedor que lo perdió → no la ve. Escribir exige que **ambos** participantes tengan acceso hoy; si no, la conversación es `readOnly` para los dos.
- Mensaje: texto recortado de 1 a 2.000 caracteres (`CHECK` en la base también). Orden (`createdAt`, `id`); paginación por cursor hacia atrás, 50 por página.
- Marcas por participante `deliveredUpTo` / `readUpTo` (instante + id de mensaje); sólo avanzan; `upTo` debe ser un mensaje de esa conversación (si no, 404); permitidas en solo lectura.
- Bandeja: `displayName` = `businessName` para proveedores, `fullName` para miembros; `role` ∈ `COUPLE | PLANNER | VENDOR`. `unreadTotal` suma también las de solo lectura.
- Socket en `user:<id>` del namespace `/realtime`: `message.created` `{ conversationId, message }` y `message.receipt` `{ conversationId, userId, deliveredUpTo, readUpTo }`. Se encolan tras el commit (fallo → `warn` y se traga). El worker re-comprueba visibilidad por destinatario antes de emitir.
- Límite de ritmo con nombre `messages` en `POST /conversations/:id/messages`: 30 por minuto (tracker existente del proyecto).
- No borrar `DESIGN-GAP`. Docblocks largos con decisión y alternativa descartada.

## Review Focus

1. Proveedor intenta abrir conversación con otro proveedor del mismo evento → 403, y no lo ve en `/contacts` (Task 3).
2. Conversación ya abierta y el proveedor es cancelado → desaparece de su bandeja y `GET …/messages` le da 404; el miembro la ve en solo lectura y no puede escribir (Task 2 paridad + Task 3 e2e).
3. Dos usuarios abren la misma conversación a la vez → una sola fila (`pairKey` único; el segundo recibe la existente, no un 500) (Task 2 integración).
4. Marcar leído con un `upTo` anterior al actual no retrocede la marca; con un id de otra conversación → 404 (Task 3).
5. Mensaje de sólo espacios o de 2.001 caracteres → 400 (Task 3).

---

### Task 1: Esquema, migración y reglas de dominio

**Files:**
- Modify: `prisma/schema.prisma` (+ `npx prisma migrate dev --name mensajeria_base`)
- Modify: `docs/DATABASE.md` (tablas, enum, CHECK, qué valida la base y qué el caso de uso)
- Create: `src/modules/messaging/domain/conversacion.ts`, `src/modules/messaging/domain/conversacion.test.ts`
- Create: `src/modules/messaging/domain/messaging-errors.ts`

**Interfaces:**
- Produces:
  ```ts
  // schema: enum ConversationKind { EVENT_DIRECT EVENT_ROOM PROFILE }
  // model Conversation { id, kind, eventId String? (FK Cascade), pairKey String? @unique, createdAt, lastMessageAt DateTime? ; @@index([eventId]) }
  // model ConversationParticipant { conversationId, userId, deliveredUpToAt DateTime?, deliveredUpToId Uuid?, readUpToAt DateTime?, readUpToId Uuid?, @@id([conversationId, userId]) , @@index([userId]) }
  // model Message { id, conversationId (FK Cascade), senderId (FK User), body String, createdAt ; @@index([conversationId, createdAt, id]) }
  // migración: CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000)
  // domain/conversacion.ts
  export type RolEnEvento = 'COUPLE' | 'PLANNER' | 'VENDOR'
  export const MAX_CARACTERES_MENSAJE = 2000
  export function claveDePar(eventId: string, a: string, b: string): string // `${eventId}:${menor}:${mayor}`
  export function parPermitido(a: RolEnEvento, b: RolEnEvento): boolean      // false sólo VENDOR↔VENDOR
  export function normalizarCuerpo(texto: string): string                   // trim; lanza MensajeInvalidoError si queda 0 o > 2000
  export interface Marca { at: Date; id: string }
  export function avanzar(actual: Marca | null, nueva: Marca): Marca        // la mayor por (at, id)
  export function alcanza(marca: Marca | null, mensaje: Marca): boolean     // marca ≥ mensaje
  // messaging-errors.ts (DomainError con httpStatus)
  MensajeInvalidoError (422 → ver nota), ConversacionNoEncontradaError (404), ParNoPermitidoError (403),
  ConversacionSoloLecturaError (403), SinAccesoAlEventoError (403)
  ```
  Nota: el 400 de "texto vacío o largo" lo da Zod en el controlador (`validarCon`); `normalizarCuerpo` es la segunda barrera y usa `UnprocessableError`.

- [ ] **Step 1: Tests de dominio (fallan)** en `conversacion.test.ts`: `claveDePar` es simétrica (`(e,a,b) === (e,b,a)`); `parPermitido` → `VENDOR/VENDOR` false y las otras 8 combinaciones true (`it.each`); `normalizarCuerpo('  hola ')` → `'hola'`, `'   '` y `'x'.repeat(2001)` lanzan, `'x'.repeat(2000)` vale; `avanzar` nunca retrocede (con `at` igual decide el `id`); `alcanza(null, m)` false.
- [ ] **Step 2:** `npx vitest run src/modules/messaging/domain` → FAIL.
- [ ] **Step 3:** Implementar dominio, schema y migración (con el `CHECK` en SQL); actualizar `docs/DATABASE.md`.
- [ ] **Step 4:** Step 2 → PASS; `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url …` vacío (o el comando de CI del README); gate.
- [ ] **Step 5: Commit** `feat(messaging): esquema y reglas de dominio de las conversaciones`

---

### Task 2: Repositorio (puerto, Prisma, doble, paridad)

**Files:**
- Create: `src/modules/messaging/application/conversation.repository.ts`
- Create: `src/modules/messaging/infrastructure/prisma-conversation.repository.ts`, `conversation.repository.fake.ts`, `conversation.repository.paridad.test.ts`, `prisma-conversation.repository.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  export interface Contacto { userId: string; displayName: string; role: RolEnEvento }
  export interface MensajeVista { id: string; conversationId: string; senderId: string; body: string; createdAt: Date }
  export interface ConversacionVista {
    id: string; event: { id: string; name: string }; other: Contacto
    lastMessage: MensajeVista | null; unreadCount: number; readOnly: boolean
    otherMarks: { deliveredUpTo: Marca | null; readUpTo: Marca | null }
  }
  export interface ConversationRepository {
    /** Rol de `userId` en el evento si tiene acceso de mensajería hoy; null si no. */
    rolEnEvento(eventId: string, userId: string): Promise<RolEnEvento | null>
    contactos(eventId: string, userId: string): Promise<Contacto[]>   // con acceso, sin él, sin VENDOR si él es VENDOR
    /** Crea o devuelve la de ese pairKey (choque de único → relee). */
    abrir(eventId: string, a: string, b: string): Promise<string>
    /** null si no existe o `userId` no puede verla (§4.1). */
    buscar(conversationId: string, userId: string): Promise<ConversacionVista | null>
    bandeja(userId: string): Promise<{ items: ConversacionVista[]; unreadTotal: number }>
    mensajes(conversationId: string, opciones: { desde: CursorValue | null; limite: number }): Promise<CursorPage<MensajeVista>>
    agregarMensaje(conversationId: string, senderId: string, body: string, ahora: Date): Promise<MensajeVista>
    /** Avanza la marca (nunca retrocede). false si `upTo` no es de la conversación. */
    marcar(conversationId: string, userId: string, tipo: 'delivered' | 'read', upTo: string): Promise<{ deliveredUpTo: Marca | null; readUpTo: Marca | null } | false>
    participantes(conversationId: string): Promise<string[]>
  }
  export const CONVERSATION_REPOSITORY = Symbol('CONVERSATION_REPOSITORY')
  // doble: registrarMiembro(eventId, userId, role: 'COUPLE'|'PLANNER', status: 'ACTIVE'|'INVITED'|'REVOKED', fullName),
  //        registrarProveedor(eventId, userId, businessName, booked: boolean), fijarPublicado(eventId, publicado), registrarEvento(eventId, name)
  ```
  "Acceso hoy" y "visible / readOnly" se calculan en la consulta con el criterio de Global Constraints. `agregarMensaje` actualiza `lastMessageAt` en la misma transacción (`clienteDe`). La bandeja ordena por `lastMessageAt` desc (nulos al final) y omite las no visibles.

- [ ] **Step 1: Paridad (falla)**, `it` en español:
  - `abrir dos veces el mismo par (en cualquier orden) devuelve la misma conversación`
  - `contactos de un proveedor: la pareja y los planners ACTIVE, nunca otros proveedores ni INVITED`
  - `contactos de un miembro: miembros ACTIVE y proveedores BOOKED de evento publicado`
  - `rolEnEvento: proveedor de evento sin publicar o cancelado → null; miembro de evento sin publicar → su rol`
  - `bandeja: un miembro revocado ve la conversación en solo lectura; un proveedor cancelado no la ve`
  - `bandeja: unreadCount cuenta los mensajes del otro posteriores a mi readUpTo; unreadTotal suma también las de solo lectura`
  - `mensajes: más recientes primero, páginas de N exactas con createdAt empatados`
  - `marcar nunca retrocede y rechaza un upTo de otra conversación`
- [ ] **Step 2:** Correr la paridad → FAIL.
- [ ] **Step 3:** Implementar puerto, Prisma y doble.
- [ ] **Step 4:** Step 2 → PASS. Integración (`prisma-conversation.repository.test.ts`): `it('dos abrir concurrentes del mismo par crean una sola conversación')` (`Promise.all`), `it('el CHECK rechaza un cuerpo vacío insertado a mano')`. Correr → PASS; gate.
- [ ] **Step 5: Commit** `feat(messaging): repositorio de conversaciones con paridad`

---

### Task 3: Casos de uso y rutas REST

**Files:**
- Create: `src/modules/messaging/application/*.use-case.ts` (abrir, bandeja, contactos, mensajes, enviar, marcar) + `messaging.use-cases.test.ts`
- Create: `src/modules/messaging/interfaces/conversations.controller.ts`, `messaging.dto.ts`
- Create: `src/modules/messaging/messaging.module.ts`; Modify: `src/app.module.ts`
- Modify: `src/shared/http/limitadores.ts` (limitador `messages`)
- Test: `test/e2e/messaging.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1 y 2.
- Produces (HTTP, todas con `JwtAuthGuard`):
  ```
  GET  /me/conversations                     → 200 { items: ConversacionJson[], unreadTotal }
  GET  /events/:eventId/contacts             → 200 { items: Contacto[] }            (403 sin acceso)
  POST /events/:eventId/conversations {userId} → 200 ConversacionJson (existente) | 201 (nueva)
                                               403 SinAccesoAlEvento / ParNoPermitido; 404 si el otro no tiene acceso
  GET  /conversations/:id/messages?cursor    → 200 { items: MensajeJson[], nextCursor, otherMarks }   (404 si no visible)
  POST /conversations/:id/messages {body}    → 201 MensajeJson  (403 readOnly; 400 Zod; limitador `messages` 30/min)
  POST /conversations/:id/delivered {upTo}   → 204   (404 upTo ajeno)
  POST /conversations/:id/read {upTo}        → 204
  ConversacionJson = { id, event: {id,name}, other: Contacto, lastMessage: MensajeJson|null, unreadCount, readOnly, otherMarks }
  MensajeJson = { id, conversationId, senderId, body, createdAt: ISO }; Marca JSON = { at: ISO, id } | null
  ```
  Las ids inválidas (no guid) → 404 como en `NotificationsController`. Los casos de uso de enviar y marcar devuelven lo necesario para que Task 4 encole (no encolan aún). Docblock del controlador: por qué no se usa `EventAccessGuard` (la regla de mensajería excluye admins y exige evento publicado a proveedores; vive en el repositorio).

- [ ] **Step 1: Unitarios (fallan)** contra el doble: abrir (par prohibido → `ParNoPermitidoError`; sin acceso → `SinAccesoAlEventoError`; con alguien sin acceso → `ConversacionNoEncontradaError`); enviar en solo lectura → `ConversacionSoloLecturaError`; enviar normaliza el cuerpo; marcar con upTo ajeno → 404.
- [ ] **Step 2:** Correr → FAIL.
- [ ] **Step 3:** Implementar casos de uso, DTO Zod (`body: z.string().trim().min(1).max(2000)`, `upTo: z.guid()`, `userId: z.guid()`), controlador, módulo y limitador.
- [ ] **Step 4:** Step 2 → PASS.
- [ ] **Step 5: E2E** `messaging.e2e.test.ts` (dueño COUPLE, PLANNER, dos proveedores BOOKED en evento publicado, otro evento ajeno, admin no miembro): cubrir Review Focus 1, 2, 4 y 5, más: `abrir dos veces devuelve la misma (201 y luego 200)`, `enviar y leer la bandeja del otro: unreadCount 1, luego read → 0`, `paginar 120 mensajes en 3 páginas sin repetir`, `un no participante recibe 404 en messages`, `un admin no miembro no puede abrir (403)`, `el límite de ritmo devuelve 429 al mensaje 31` (con el helper de `test/support/throttler.ts`). Correr → PASS.
- [ ] **Step 6:** `npm test` + gate.
- [ ] **Step 7: Commit** `feat(messaging): rutas de conversaciones y mensajes`

---

### Task 4: Tiempo real

**Files:**
- Modify: `src/modules/queue/application/queue.port.ts` (`QueueName` + `'messaging'`)
- Create: `src/modules/messaging/application/avisos-mensajeria.ts` (contrato de jobs + `encolar…` con warn-y-traga)
- Create: `src/modules/messaging/interfaces/messaging.processor.ts` (+ test)
- Modify: casos de uso de enviar y marcar (encolar tras persistir), `messaging.module.ts` (`registerQueue`, `REALTIME_PORT` desde `NotificationsModule`)
- Test: `test/e2e/realtime.e2e.test.ts` (o `messaging-realtime.e2e.test.ts`)

**Interfaces:**
- Consumes: Task 3; `REALTIME_PORT.emitirAUsuario(userId, evento, payload)` exportado por `NotificationsModule`.
- Produces:
  ```ts
  export const COLA_MENSAJERIA = 'messaging'
  export const EVENTO_MENSAJE_CREADO = 'message.created'
  export const EVENTO_MENSAJE_RECIBO = 'message.receipt'
  export interface JobMensajeCreado { conversationId: string; messageId: string }
  export interface JobRecibo { conversationId: string; userId: string }
  ```
  El worker lee el mensaje/las marcas actuales del repositorio (no del job), y para cada destinatario (participantes salvo el emisor en `message.created`; el otro participante en `message.receipt`) comprueba `buscar(conversationId, destinatario) !== null` antes de `emitirAUsuario`. Payloads: `message.created` `{ conversationId, message: MensajeJson }`; `message.receipt` `{ conversationId, userId, deliveredUpTo, readUpTo }`. Nombre de job desconocido o payload roto → `UnrecoverableError` (patrón de `NotificationProcessor`). jobIds con `-`, nunca `:`.

- [ ] **Step 1: Tests del worker (fallan)**: `it('message.created llega al otro participante y no al emisor')`, `it('no se emite a un proveedor que ya no puede ver la conversación')`, `it('message.receipt llega al otro participante con las marcas actuales')`, `it('un job roto es irrecuperable con mensaje claro')` (asertar el mensaje).
- [ ] **Step 2:** Correr → FAIL.
- [ ] **Step 3:** Implementar contrato, encolado en los casos de uso, worker y cableado.
- [ ] **Step 4:** Step 2 → PASS; unitarios de enviar: `encola tras persistir` y `si encolar falla, el envío responde igual` (asertar el `warn`).
- [ ] **Step 5: E2E socket**: con dos clientes Socket.IO reales (patrón de `realtime.e2e.test.ts`), `it('el destinatario recibe message.created al enviar y el emisor recibe message.receipt al leer')`. Correr → PASS.
- [ ] **Step 6:** `npm test`, gate, `npm run build && npm run test:smoke`.
- [ ] **Step 7: Commit** `feat(messaging): mensajes y recibos en tiempo real`
