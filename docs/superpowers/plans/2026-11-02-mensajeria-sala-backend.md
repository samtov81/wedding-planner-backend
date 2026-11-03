# Mensajería parte 2 (backend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sala de grupo por evento para la pareja y los planners (sin proveedores), con "leído por N de M" y quién lo leyó.

**Architecture:** Se extiende el módulo `messaging` sin puerto nuevo: la sala es una `Conversation` de `kind = 'EVENT_ROOM'` con `pairKey = 'room:<eventId>'`, creada de forma perezosa. Una tabla nueva `message_recipients` fija los destinatarios de cada mensaje al enviarlo (M, "hasta que salió", no leídos). Las rutas y el worker de la parte 1 despachan por tipo con un único `localizarConversacion`.

**Tech Stack:** NestJS 11, Prisma 6 / Postgres 16, BullMQ, Socket.IO, Zod, Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-11-02-mensajeria-sala-design.md` (y la parte 1, `2026-10-29-mensajeria-base-design.md`).

## Global Constraints

- Rama `feat/mensajeria-sala` (desde `develop`). Sin push ni PR. Nunca hacer stage de `.claude/settings.json`.
- Español en comentarios, docblocks y `describe`/`it`; strings de API en inglés. Prettier: sin `;`, comillas simples, ancho 100.
- Gate por tarea: `npm run typecheck && npm run lint && npx prettier --check .` + tests tocados; todo cambio de `schema.prisma` con migración (CI corre `prisma migrate diff`).
- En la sala está quien es miembro **ACTIVE** (COUPLE/PLANNER) hoy. Proveedores, `INVITED` y admins sin membresía: nunca.
- Miembro no ACTIVE con fila de participante y alguna membresía (REVOKED/INVITED) → solo lectura, visible sólo hasta su último mensaje como remitente o destinatario (`visibleHasta`; null = nada).
- Destinatarios de un mensaje = miembros ACTIVE del evento en ese instante, sin el remitente; se guardan en la misma transacción que el mensaje.
- No leídos en sala = mensajes donde soy destinatario posteriores a mi `readUpTo`.
- Salas fuera de `GET /me/conversations` y de su `unreadTotal`.
- Socket: los mismos `message.created` / `message.receipt` y la misma cola `messaging`.

## Review Focus

1. Un revocado pide la página de mensajes o marca `read` con el id de un mensaje posterior a su salida → no lo ve / 404 (Task 3).
2. Un miembro ACTIVE que nunca abrió la sala marca `read` → 204, no 404 por falta de fila de participante (Task 3).
3. Dos peticiones abren a la vez la sala del mismo evento → una sola sala, ninguna 500 (Task 2).
4. Un revocado que sigue siendo participante NO recibe por socket `message.created` de un mensaje posterior a su salida (Task 4).
5. Alguien que no es el remitente pide `readers` de un mensaje → 404 (Task 3).

---

### Task 1: Esquema, migración y dominio de la sala

**Files:**
- Modify: `prisma/schema.prisma`; Create: `prisma/migrations/20261102120000_mensajeria_sala/migration.sql`
- Modify: `docs/DATABASE.md` (sección `message_recipients`, CHECK nuevo en `conversations`)
- Create: `src/modules/messaging/domain/sala.ts`, `sala.test.ts`; Modify: `domain/messaging-errors.ts`

**Interfaces:**
- Produces:
  ```ts
  // schema: model MessageRecipient { messageId (FK Message, Cascade), userId (FK User, Cascade),
  //   @@id([messageId, userId]), @@index([userId, messageId]), @@map("message_recipients") }
  // migración: + CHECK conversations_sala_clave
  //   ("kind" <> 'EVENT_ROOM' OR ("eventId" IS NOT NULL AND "pairKey" = 'room:' || "eventId"::text))
  export const claveDeSala = (eventId: string): string // 'room:<eventId>'
  export interface MarcasDe { deliveredUpTo: Marca | null; readUpTo: Marca | null }
  export function resumenDeLectura(destinatarios: readonly string[], marcas: ReadonlyMap<string, MarcasDe>, mensaje: Marca): { total: number; delivered: number; read: number }
  export function lectoresDe(destinatarios: readonly string[], marcas: ReadonlyMap<string, MarcasDe>, mensaje: Marca): { read: string[]; unread: string[] }
  export class SalaNoDisponibleError extends ForbiddenError // 'ROOM_ACCESS_DENIED'
  ```
- [ ] **Step 1:** Tests de dominio: `resumenDeLectura` cuenta sólo destinatarios (un no destinatario con marca mayor no suma), destinatario sin marcas → ni recibido ni leído, empate de `at` decide por `id`; `lectoresDe` reparte conservando el orden de `destinatarios`; `claveDeSala`.
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3:** Esquema + migración con `prisma migrate diff --from-migrations … --to-schema-datamodel … --script` (shadow en Testcontainers o local) + CHECK a mano; DATABASE.md.
- [ ] **Step 4:** Gate y commit `feat(messaging): esquema y dominio de la sala del evento`.

### Task 2: Repositorio de la sala (puerto, Prisma, doble, paridad)

**Files:** Modify: `application/conversation.repository.ts`, `infrastructure/prisma-conversation.repository.ts`, `infrastructure/conversation.repository.fake.ts`, `infrastructure/conversation.repository.paridad.test.ts`, `infrastructure/prisma-conversation.repository.test.ts`

**Interfaces:**
- Produces (en `conversation.repository.ts`):
  ```ts
  export interface SalaVista {
    id: string; event: { id: string; name: string }; memberCount: number
    lastMessage: MensajeVista | null; unreadCount: number; readOnly: boolean
    /** Sólo con readOnly: último mensaje visible; null = ninguno. Sin readOnly, null. */
    visibleHasta: Marca | null
  }
  export interface MarcaDeMiembro extends MarcasDeParticipante { userId: string; displayName: string; role: 'COUPLE' | 'PLANNER' }
  // nuevos métodos del puerto
  abrirSala(eventId: string, userId: string): Promise<string | null>  // si userId es ACTIVE: crea sala+participante (idempotente) y da el id; si no, id existente o null
  buscarSala(conversationId: string, userId: string): Promise<SalaVista | null>
  salas(userId: string): Promise<{ items: SalaVista[]; unreadTotal: number }> // asegura sala+participante en cada evento ACTIVE; orden como bandeja
  agregarMensajeDeSala(conversationId: string, senderId: string, body: string, ahora: Date): Promise<{ mensaje: MensajeVista; destinatarios: string[] }>
  marcasDeSala(conversationId: string): Promise<MarcaDeMiembro[]>
  destinatariosDe(messageIds: readonly string[]): Promise<Map<string, string[]>>
  // cambia: mensajes(conversationId, { desde, limite, hasta?: Marca | null | undefined }) — undefined sin tope; null página vacía
  // doble: los escenarios de la parte 1 bastan (registrarMiembro cambia el status)
  ```
  `buscar`/`bandeja` siguen filtrando `kind: 'EVENT_DIRECT'`. `abrirSala` con `INSERT … ON CONFLICT ("pairKey") DO NOTHING` como `abrir`, y participante con `ON CONFLICT DO NOTHING`. `agregarMensajeDeSala` en `enTransaccion`: mensaje, `message_recipients`, participantes (`createMany skipDuplicates`), `lastMessageAt`.
- [ ] **Step 1: Paridad (falla):**
  - `abrirSala: crea una sola por evento; un proveedor o un admin sin membresía obtiene null si no existe`
  - `agregarMensajeDeSala: destinatarios = ACTIVE sin el remitente; nunca proveedores ni INVITED`
  - `buscarSala: quien entra tarde ve el historial con 0 no leídos`
  - `buscarSala: un revocado la ve en solo lectura hasta su último mensaje; null si no recibió ninguno`
  - `buscarSala: un readmitido vuelve a escribir y sin tope`
  - `buscarSala: proveedor y admin → null`
  - `salas: crea la de cada evento ACTIVE, incluye las de solo lectura y suma unreadTotal`
  - `mensajes con hasta: corta en el tope; con null, vacía`
  - `marcasDeSala y destinatariosDe devuelven lo mismo en los dos`
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3:** Integración: `dos abrirSala concurrentes del mismo evento crean una sola sala`; `el CHECK rechaza una sala con pairKey ajena`. Gate; commit `feat(messaging): repositorio de la sala del evento con paridad`.

### Task 3: Casos de uso y rutas

**Files:**
- Create: `application/localizar-conversacion.ts`, `application/open-room.use-case.ts`, `application/list-rooms.use-case.ts`, `application/list-room-readers.use-case.ts`
- Modify: `list-messages.use-case.ts`, `send-message.use-case.ts`, `mark-conversation.use-case.ts`, `messaging.use-cases.test.ts`
- Modify: `interfaces/conversations.controller.ts`, `messaging.json.ts`, `messaging.module.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ConversacionLocalizada = { tipo: 'directa'; vista: ConversacionVista } | { tipo: 'sala'; vista: SalaVista }
  export async function localizarConversacion(repo, conversationId, userId): Promise<ConversacionLocalizada | null>
  OpenRoomUseCase.ejecutar(userId, eventId): Promise<SalaVista>          // SalaNoDisponibleError si no la ve
  ListRoomsUseCase.ejecutar(userId): Promise<{ items: SalaVista[]; unreadTotal: number }>
  ListRoomReadersUseCase.ejecutar(userId, conversationId, messageId): Promise<{ read: Contacto[]; unread: Contacto[] }>
  ListMessagesUseCase.ejecutar(...) : Promise<
    | { tipo: 'directa'; pagina; otherMarks }
    | { tipo: 'sala'; pagina; marks: MarcaDeMiembro[]; recibos: Map<string, { recipientIds: string[]; total; delivered; read }> }>
  // JSON: SalaJson { id, kind: 'EVENT_ROOM', event, memberCount, lastMessage, unreadCount, readOnly }
  // rutas: GET me/rooms, GET events/:eventId/room, GET conversations/:id/messages/:messageId/readers
  ```
  Mark en sala: `upTo` debe existir y, si `readOnly`, `alcanza(visibleHasta, upTo)`; si no, 404. Antes de `marcar`, `abrirSala(event.id, userId)` (asegura la fila del participante de un ACTIVE).
- [ ] **Step 1:** Unitarios (fallan) contra el doble: abrir sala como proveedor → 403; enviar en solo lectura → 403; marcar read con upTo posterior a la salida → 404; ACTIVE que nunca abrió marca → ok; readers de un no remitente → 404; mensajes de sala trae `recibos` sólo de mis mensajes.
- [ ] **Step 2:** Implementar → PASS. Gate; commit `feat(messaging): rutas de la sala del evento`.

### Task 4: Tiempo real y e2e

**Files:** Modify: `interfaces/messaging.processor.ts`, `messaging.processor.test.ts`; Create: `test/e2e/messaging-sala.e2e.test.ts`

- `message.created` en sala: a `remitente ∪ destinatariosDe(messageId)`, cada uno re-comprobado con `buscarSala` (y `alcanza(visibleHasta, mensaje)` si `readOnly`). Recibo en sala: a cada participante con `buscarSala` no null salvo quien marcó, con las marcas de quien marcó sacadas de `marcasDeSala`.
- [ ] **Step 1:** Test del processor: revocado participante no recibe un mensaje posterior; recibo de sala lleva las marcas del que marcó.
- [ ] **Step 2:** e2e (Testcontainers, `arrancarAppDeTest`): creador ve la sala vacía; proveedor 403 y no es destinatario; entra tarde → historial, 0 no leídos; N de M sube al leer; `readers`; revocado lee hasta su salida, 403 al escribir; readmitido escribe; socket `message.created` a la sala y `message.receipt` al remitente; las salas no salen en `/me/conversations`.
- [ ] **Step 3:** Gate completo (`npm test`, `npm run build && npm run test:smoke`, `migrate diff`); commit `feat(messaging): sala del evento en tiempo real`.
