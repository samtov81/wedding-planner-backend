# Mensajería parte 3 (backend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contacto desde la ficha pública de un proveedor: solicitud con un primer mensaje que el proveedor acepta o rechaza, y después un hilo 1:1 normal.

**Architecture:** Se extiende el módulo `messaging`. La solicitud es una `Conversation` de `kind = 'PROFILE'` con `pairKey = 'profile:<menor>:<mayor>'` y cuatro columnas nuevas (`requesterId`, `vendorProfileId`, `requestStatus`, `declinedAt`). Las reglas de transición viven en un dominio puro (`domain/perfil.ts`) que llaman por igual el doble y Prisma. `localizarConversacion` gana el tipo `perfil`, así que mensajes, envío y marcas reutilizan las rutas `/conversations/:id/...`. Un controlador nuevo sirve las rutas de contacto. Un guard nuevo en `shared/http` cuenta por usuario autenticado sobre el mismo almacén Redis del throttler.

**Tech Stack:** NestJS 11, Prisma 6 / Postgres 16, `@nestjs/throttler` + `@nest-lab/throttler-storage-redis`, BullMQ, Socket.IO, Zod, Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-11-03-mensajeria-perfil-design.md` (y las partes 1 y 2 en la misma carpeta).

## Global Constraints

- Rama `feat/mensajeria-perfil` (ya creada desde `develop`). Sin push ni PR hasta el final. Nunca hacer stage de `.claude/settings.json`.
- Español en comentarios, docblocks y `describe`/`it`; strings de API en inglés. Prettier: sin `;`, comillas simples, ancho 100. Docblocks con la decisión y la alternativa descartada.
- Gate por tarea: `npm run typecheck && npm run lint && npx prettier --check .` + tests tocados. Todo cambio de `schema.prisma` lleva migración (CI corre `prisma migrate diff`).
- Mensaje: 1–2.000 caracteres tras recortar (`normalizarCuerpo`); historial 50 por página; sin editar ni borrar.
- Espera tras rechazo: exactamente 24 h (`86_400_000` ms) desde `declinedAt`; se puede volver a pedir cuando `ahora >= declinedAt + 24h`.
- Límite `contact-requests`: 10 por hora (`ttl: 3_600_000`, `limit: 10`) por `userId` autenticado; 429 con la misma forma que el throttler (`ThrottlerException`). Cuenta también lo que después falla con 404/409/422. `messages` e `invite` no se tocan.
- Códigos de error, exactos: `VENDOR_PROFILE_NOT_FOUND` (404), `CONTACT_SELF` (422), `CONTACT_REQUEST_PENDING` (409 al pedir; 403 al escribir), `CONTACT_ALREADY_ACCEPTED` (409, `details: { conversationId }`), `CONTACT_REQUEST_COOLDOWN` (409, `details: { retryAt }` ISO), `CONTACT_DECLINED_BY_YOU` (409), `CONTACT_REQUEST_NOT_PENDING` (409), `CONVERSATION_NOT_FOUND` (404), `CONVERSATION_READ_ONLY` (403).
- Nada de `PROFILE` en `GET /me/conversations` ni en `GET /me/rooms` (los dos filtran ya por `kind`; no cambiar eso).
- Socket: `message.created` / `message.receipt` como siempre y uno nuevo, `contact.updated` `{ conversationId }`, por la cola `messaging`.

## Review Focus

1. A pide a B y B pide a A a la vez (los dos con ficha) → una sola conversación; la segunda petición recibe 409 `CONTACT_REQUEST_PENDING`, ninguna 500 (Task 2, integración).
2. Reintento justo en el límite: con `ahora = declinedAt + 24h` se permite; con 1 ms menos, 409 con `retryAt` (Task 1).
3. Un cuerpo de sólo espacios en `POST /vendors/:id/contact` → 400 y no crea conversación, pero gasta cupo (Task 4 y e2e en Task 5).
4. El proveedor rechaza, el solicitante reintenta: el proveedor vuelve a verla en sus solicitudes con todo el historial, y entre medias no recibía nada de ella por socket (Task 5).
5. El solicitante llama a `accept`/`decline` sobre su propia solicitud → 404, no 403 (Task 3).

---

### Task 1: Esquema, migración, dominio y errores

**Files:**
- Modify: `prisma/schema.prisma`; Create: `prisma/migrations/20261103120000_mensajeria_perfil/migration.sql`
- Modify: `docs/DATABASE.md` (columnas y CHECK nuevos de `conversations`, enum `ContactRequestStatus`)
- Create: `src/modules/messaging/domain/perfil.ts`, `perfil.test.ts`
- Modify: `src/modules/messaging/domain/messaging-errors.ts`
- Modify: `src/shared/domain/domain-error.ts` (`ConflictError` acepta `details?: unknown` como 3.er argumento, igual que `UnprocessableError`)

**Interfaces:**
- Produces:
  ```ts
  // schema: enum ContactRequestStatus { PENDING ACCEPTED DECLINED }
  // Conversation += requesterId String? @db.Uuid (FK User, onDelete: Cascade),
  //   vendorProfileId String? @db.Uuid (FK VendorProfile, onDelete: Cascade),
  //   requestStatus ContactRequestStatus?, declinedAt DateTime?
  // CHECKs a mano en la migración:
  //   conversations_perfil_campos: ("kind" = 'PROFILE') = ("eventId" IS NULL AND "requesterId" IS NOT NULL
  //     AND "vendorProfileId" IS NOT NULL AND "requestStatus" IS NOT NULL)
  //   conversations_perfil_rechazo: ("declinedAt" IS NOT NULL) = ("requestStatus" = 'DECLINED')
  //     — con requestStatus NULL ambos lados deben ser false: usar COALESCE("requestStatus" = 'DECLINED', false)
  //   conversations_perfil_clave: "kind" <> 'PROFILE' OR "pairKey" LIKE 'profile:%'

  // domain/perfil.ts
  export type EstadoDeSolicitud = 'PENDING' | 'ACCEPTED' | 'DECLINED'
  export const ESPERA_TRAS_RECHAZO_MS = 86_400_000
  export const claveDePerfil = (a: string, b: string): string // 'profile:<menor>:<mayor>'
  export interface ParDePerfil { conversationId: string; requesterId: string; vendorUserId: string; status: EstadoDeSolicitud; declinedAt: Date | null }
  export const reintentoEn = (declinedAt: Date): Date
  /** Decide qué hace POST contact. Lanza el error de dominio que toque. */
  export function evaluarSolicitud(e: { solicitante: string; duenoDeFicha: string; par: ParDePerfil | null; relacionados: boolean; ahora: Date }):
    { accion: 'crear' | 'reintentar'; estado: 'PENDING' | 'ACCEPTED' }
  export type EstadoDeContacto = 'NONE' | 'PENDING_SENT' | 'PENDING_RECEIVED' | 'ACCEPTED' | 'DECLINED' | 'DECLINED_BY_ME' | 'SELF'
  export function estadoDeContacto(yo: string, duenoDeFicha: string, par: ParDePerfil | null):
    { state: EstadoDeContacto; conversationId: string | null; retryAt: Date | null }
  /** ¿Puede `userId` ver la conversación? El solicitante siempre; el proveedor salvo DECLINED. */
  export function veConversacionDePerfil(par: ParDePerfil, userId: string): boolean
  // errores (messaging-errors.ts)
  FichaNoDisponibleError extends NotFoundError        // 'VENDOR_PROFILE_NOT_FOUND'
  AutocontactoError extends UnprocessableError         // 'CONTACT_SELF'
  SolicitudPendienteError extends ConflictError        // 'CONTACT_REQUEST_PENDING' (409)
  EscrituraEnSolicitudPendienteError extends ForbiddenError // 'CONTACT_REQUEST_PENDING' (403)
  ContactoYaAceptadoError extends ConflictError        // 'CONTACT_ALREADY_ACCEPTED', details { conversationId }
  EsperaTrasRechazoError extends ConflictError         // 'CONTACT_REQUEST_COOLDOWN', details { retryAt: ISO }
  RechazadoPorTiError extends ConflictError            // 'CONTACT_DECLINED_BY_YOU'
  SolicitudNoPendienteError extends ConflictError      // 'CONTACT_REQUEST_NOT_PENDING'
  ```
  Orden de `evaluarSolicitud`: autocontacto → sin par: `crear` (`ACCEPTED` si `relacionados`) → `PENDING`: 409 pendiente (sea quien sea el solicitante) → `ACCEPTED`: 409 aceptado → `DECLINED` y `solicitante !== par.requesterId`: `RechazadoPorTiError` → `relacionados`: `reintentar` + `ACCEPTED` → `ahora < reintentoEn`: espera → `reintentar` + `PENDING`.
  `estadoDeContacto`: `SELF` si `yo === duenoDeFicha` (antes de mirar el par); `PENDING` → `PENDING_SENT`/`PENDING_RECEIVED` según `requesterId`; `DECLINED` → `DECLINED` (con `retryAt`) para el solicitante, `DECLINED_BY_ME` para el otro.
- [ ] **Step 1: Tests de dominio (fallan)** en `perfil.test.ts`:
  - `claveDePerfil('b','a') === claveDePerfil('a','b') === 'profile:a:b'`
  - `evaluarSolicitud` en cada rama del orden de arriba; con `relacionados` y sin par → `{ accion: 'crear', estado: 'ACCEPTED' }`; reintento con `ahora = declinedAt + 86_400_000` → `reintentar`; con `- 1` ms → `EsperaTrasRechazoError` cuyo `details.retryAt` es `reintentoEn(declinedAt).toISOString()`; reintento relacionado antes de 24 h → `ACCEPTED`; quien rechazó → `RechazadoPorTiError`.
  - `estadoDeContacto` para cada uno de los 7 estados.
  - `veConversacionDePerfil`: proveedor con `DECLINED` → false; solicitante con `DECLINED` → true.
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3:** Esquema + migración (`prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` contra un shadow en Testcontainers o local) y los tres CHECK a mano; `DATABASE.md`. Comprobar con `prisma migrate diff` que no queda deriva.
- [ ] **Step 4:** Gate; commit `feat(messaging): esquema y dominio del contacto desde el perfil`.

### Task 2: Repositorio (puerto, Prisma, doble, paridad, integración)

**Files:** Modify: `application/conversation.repository.ts`, `infrastructure/prisma-conversation.repository.ts`, `infrastructure/conversation.repository.fake.ts`, `infrastructure/conversation.repository.paridad.test.ts`, `infrastructure/prisma-conversation.repository.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ParDePerfil`, `evaluarSolicitud`, `veConversacionDePerfil`, `claveDePerfil`, `reintentoEn`, errores).
- Produces (en `conversation.repository.ts`):
  ```ts
  export interface FichaParaContacto { id: string; userId: string; businessName: string; publicada: boolean }
  export interface ConversacionDePerfilVista {
    id: string; status: EstadoDeSolicitud; direction: 'SENT' | 'RECEIVED'
    other: { userId: string; displayName: string; role: 'VENDOR' | 'CONTACT' }
    vendor: { id: string; businessName: string }
    lastMessage: MensajeVista | null; unreadCount: number
    readOnly: boolean            // status !== 'ACCEPTED'
    retryAt: Date | null         // sólo DECLINED vista por el solicitante
    otherMarks: MarcasDeParticipante
  }
  // nuevos métodos del puerto
  fichaParaContacto(vendorProfileId: string): Promise<FichaParaContacto | null>
  parDePerfil(a: string, b: string): Promise<ParDePerfil | null>
  /** Podrían abrir hoy una EVENT_DIRECT entre sí en algún evento (reglas parte 1 §4.1; nunca VENDOR↔VENDOR). */
  tienenRelacion(a: string, b: string): Promise<boolean>
  /** En una transacción, bloqueando la fila del par: evalúa con `evaluarSolicitud`, crea o reintenta, y añade el mensaje. */
  solicitar(e: { solicitante: string; ficha: FichaParaContacto; cuerpo: string; relacionados: boolean; ahora: Date }):
    Promise<{ conversationId: string; mensaje: MensajeVista }>
  /** Sólo el proveedor y sólo en PENDING. */
  responder(conversationId: string, userId: string, decision: 'ACCEPTED' | 'DECLINED', ahora: Date):
    Promise<'ok' | 'no-encontrada' | 'no-pendiente'>
  /** null si no es PROFILE o `userId` no la ve (`veConversacionDePerfil`). */
  buscarPerfil(conversationId: string, userId: string): Promise<ConversacionDePerfilVista | null>
  /** Las que ve `userId`, por lastMessageAt desc. requestsPending = RECEIVED+PENDING; unreadTotal = unreadCount de las ACCEPTED. */
  perfiles(userId: string): Promise<{ items: ConversacionDePerfilVista[]; requestsPending: number; unreadTotal: number }>
  // cambia: tipoDe(...) => Promise<'EVENT_DIRECT' | 'EVENT_ROOM' | 'PROFILE' | null>
  ```
  Nombres (spec §3.7): proveedor = `businessName` de `vendorProfileId`, rol `VENDOR`; solicitante = `fullName`, rol `CONTACT`. `solicitar` en Prisma: dentro de `enTransaccion`, `INSERT … ON CONFLICT ("pairKey") DO NOTHING RETURNING id` sólo cuando `parDePerfil` dio null y `evaluarSolicitud` dijo `crear`; si el INSERT no inserta (carrera), `SELECT … FOR UPDATE` de la fila y volver a evaluar con ella. Reintento: `requestStatus` al nuevo estado, `declinedAt = NULL`. Mensaje + `lastMessageAt` en la misma transacción (como `agregarMensaje`). `responder`: `SELECT … FOR UPDATE`; `DECLINED` pone `declinedAt = ahora`. El doble usa las mismas funciones de dominio y necesita `sembrarFicha(userId, { businessName, publicada })`.
- [ ] **Step 1: Paridad (falla)** en `conversation.repository.paridad.test.ts`:
  - `solicitar: crea PENDING con dos participantes y el primer mensaje; la vista del proveedor es RECEIVED con el nombre del solicitante y rol CONTACT`
  - `solicitar: relacionados → ACCEPTED`
  - `solicitar: segunda petición con PENDING → SolicitudPendienteError, también en sentido contrario`
  - `responder: DECLINED oculta la conversación al proveedor y da retryAt al solicitante; un segundo responder → no-pendiente; el solicitante → no-encontrada`
  - `solicitar tras rechazo: antes de 24 h espera; después vuelve a PENDING con el historial anterior`
  - `perfiles: requestsPending cuenta las recibidas pendientes; unreadTotal sólo las aceptadas`
  - `tienenRelacion: miembro ACTIVE ↔ proveedor BOOKED de evento publicado sí; dos proveedores del mismo evento no; evento sin publicar con proveedor no`
  - `fichaParaContacto: DRAFT/SUSPENDED → publicada false; id inexistente → null`
  - `bandeja y salas no incluyen PROFILE`
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3: Integración** en `prisma-conversation.repository.test.ts`: `A→B y B→A concurrentes crean una sola conversación y la otra recibe SolicitudPendienteError`; un `INSERT` directo que viola cada uno de los tres CHECK falla; dos `profile:` con la misma clave chocan en el UNIQUE.
- [ ] **Step 4:** Gate; commit `feat(messaging): repositorio del contacto desde el perfil con paridad`.

### Task 3: Casos de uso y tipo `perfil` en las rutas existentes

**Files:**
- Create: `application/request-contact.use-case.ts`, `application/respond-contact.use-case.ts`, `application/get-contact-state.use-case.ts`, `application/list-profile-conversations.use-case.ts`, `application/perfil.use-cases.test.ts`
- Modify: `application/localizar-conversacion.ts`, `send-message.use-case.ts`, `list-messages.use-case.ts`, `mark-conversation.use-case.ts`, `application/avisos-mensajeria.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  ```ts
  export type ConversacionLocalizada = … | { tipo: 'perfil'; vista: ConversacionDePerfilVista }
  RequestContactUseCase.ejecutar(userId: string, vendorProfileId: string, texto: string):
    Promise<{ conversacion: ConversacionDePerfilVista; mensaje: MensajeVista }>
  RespondContactUseCase.ejecutar(userId: string, conversationId: string, decision: 'ACCEPTED' | 'DECLINED'):
    Promise<ConversacionDePerfilVista>
  GetContactStateUseCase.ejecutar(userId: string, vendorProfileId: string):
    Promise<{ state: EstadoDeContacto; conversationId: string | null; retryAt: Date | null }>
  ListProfileConversationsUseCase.ejecutar(userId: string): Promise<ReturnType<ConversationRepository['perfiles']>>
  // avisos-mensajeria.ts
  export const EVENTO_CONTACTO_ACTUALIZADO = 'contact.updated'
  export interface JobContactoActualizado { conversationId: string; estado: EstadoDeSolicitud; mensajeId: string | null }
  export const jobIdDeContacto = (j: JobContactoActualizado): string // `contact-${conversationId}-${estado}-${mensajeId ?? 'none'}`
  export function encolarAvisoContacto(cola: QueuePort, registro: Logger, job: JobContactoActualizado): Promise<void>
  ```
  `RequestContact`: `fichaParaContacto` null o `!publicada` → `FichaNoDisponibleError`; `ficha.userId === userId` → `AutocontactoError`; `normalizarCuerpo`; `tienenRelacion`; `solicitar`; encola `message.created` y `contact.updated`; devuelve `buscarPerfil(id, userId)`. `GetContactState`: ficha null → 404; ficha no publicada y sin par → 404; si no, `estadoDeContacto`. `RespondContact`: `no-encontrada` → `ConversacionNoEncontradaError`; `no-pendiente` → `SolicitudNoPendienteError`; encola `contact.updated`. `localizarConversacion` prueba `buscarPerfil` en tercer lugar. `SendMessage` con perfil y `readOnly`: `PENDING` → `EscrituraEnSolicitudPendienteError`, `DECLINED` → `ConversacionSoloLecturaError`; si no, como la directa. `ListMessages` y `MarkConversation`: el perfil se trata como la directa (`otherMarks`). El caso de uso que lista lectores sigue siendo sólo para salas (perfil → 404).
- [ ] **Step 1: Unitarios (fallan)** contra el doble: ficha DRAFT → 404; autocontacto → 422; cuerpo de espacios → `MensajeInvalidoError` y no hay conversación; solicitante escribe en PENDING → 403 `CONTACT_REQUEST_PENDING`; proveedor escribe en PENDING → 403; tras aceptar escriben los dos; solicitante en DECLINED → 403 `CONVERSATION_READ_ONLY`; proveedor no localiza una DECLINED (404); estado `GET` con ficha despublicada y par aceptado → `ACCEPTED`; con ficha despublicada sin par → 404; encolados: `solicitar` encola `message.created` y `contact.updated`, `responder` sólo `contact.updated`; `readers` sobre un perfil → 404.
- [ ] **Step 2:** Implementar → PASS. Gate; commit `feat(messaging): casos de uso del contacto desde el perfil`.

### Task 4: Límite por usuario y rutas

**Files:**
- Create: `src/shared/http/limite-por-usuario.ts`, `src/shared/http/limite-por-usuario.test.ts`
- Create: `src/modules/messaging/interfaces/contact-requests.controller.ts`
- Modify: `interfaces/messaging.dto.ts`, `interfaces/messaging.json.ts`, `messaging.module.ts`, `src/shared/http/limitadores.ts` (sólo un comentario que remita al nuevo mecanismo para quien quiera migrar `messages`/`invite`; no tocar sus límites)

**Interfaces:**
- Consumes: Task 3.
- Produces:
  ```ts
  // shared/http/limite-por-usuario.ts
  export const LIMITE_CONTACT_REQUESTS = 'contact-requests'
  export function LimitePorUsuario(nombre: string, opciones: { limit: number; ttl: number }): MethodDecorator
    // = applyDecorators(SetMetadata(<clave>, { nombre, ...opciones }), UseGuards(LimitePorUsuarioGuard))
  export class LimitePorUsuarioGuard implements CanActivate
    // inyecta ThrottlerStorage (@InjectThrottlerStorage()) y Reflector; lee req.user.id
    // (tipo local { user?: { id: string } }: shared/ no importa módulos);
    // sin req.user → UnauthorizedError (fail closed: se usó sin JwtAuthGuard delante);
    // storage.increment(`usuario:${id}`, ttl, limit, ttl, nombre); isBlocked → throw new ThrottlerException()
  // controlador (JwtAuthGuard a nivel de clase, así corre ANTES que el guard del método)
  GET  vendors/:vendorId/contact          → { state, conversationId, retryAt: string | null }
  POST vendors/:vendorId/contact {body}   → 201 { conversation: ConversacionDePerfilJson, message: MensajeJson }
       @LimitePorUsuario(LIMITE_CONTACT_REQUESTS, { limit: 10, ttl: 3_600_000 })
  POST conversations/:id/accept           → 200 ConversacionDePerfilJson
  POST conversations/:id/decline          → 200 ConversacionDePerfilJson
  GET  me/profile-conversations           → { items: ConversacionDePerfilJson[], requestsPending, unreadTotal }
  // messaging.json.ts
  export interface ConversacionDePerfilJson { id; kind: 'PROFILE'; status; direction; other; vendor;
    lastMessage: MensajeJson | null; unreadCount; readOnly; retryAt: string | null; otherMarks: OtherMarksJson }
  export const conversacionDePerfilJson: (v: ConversacionDePerfilVista) => ConversacionDePerfilJson
  ```
  Ids de ruta inválidos → 404 con `idDeRuta` (ficha: `FichaNoDisponibleError`; conversación: `ConversacionNoEncontradaError`). El cuerpo con `enviarMensajeSchema` existente. `GET /conversations/:id/messages` de un perfil responde la forma de la 1:1 (`otherMarks`).
- [ ] **Step 1: Unitario del guard (falla)**: 10 pasan y el 11.º lanza `ThrottlerException` con un `ThrottlerStorage` en memoria; dos usuarios no comparten cupo; sin `req.user` → `UnauthorizedError`.
- [ ] **Step 2:** Implementar guard y controlador → PASS. Gate; commit `feat(messaging): rutas de contacto y límite por usuario`.

### Task 5: Tiempo real y e2e

**Files:** Modify: `interfaces/messaging.processor.ts`, `messaging.processor.test.ts`; Create: `test/e2e/messaging-perfil.e2e.test.ts`

- `message.created` en `PROFILE`: a cada participante que `buscarPerfil` aún ve (el proveedor de una rechazada no). `contact.updated` (job nuevo en el `switch`): emite `{ conversationId }` a la sala `user:<id>` de **todos** los participantes (no lleva contenido, y el proveedor que rechazó necesita saber que desapareció en sus otras pestañas). `message.receipt` en perfil, como la 1:1.
- [ ] **Step 1: Processor (falla)**: `message.created` de una rechazada no llega al proveedor; `contact.updated` llega a los dos con sólo el id.
- [ ] **Step 2: e2e** (`arrancarAppDeTest`, `limpiarContadoresDeRitmo` en `beforeEach`; fichas sembradas con Prisma, una `PUBLISHED`, una `DRAFT`):
  - solicitante: `POST contact` 201 → `GET contact` `PENDING_SENT`; segundo `POST` 409 `CONTACT_REQUEST_PENDING`; `POST /conversations/:id/messages` 403.
  - proveedor: `GET me/profile-conversations` con `requestsPending: 1`, el texto completo y `other.displayName` = `fullName`; escribir antes de aceptar 403; `accept` → los dos escriben y se ven; `accept` otra vez 409 `CONTACT_REQUEST_NOT_PENDING`.
  - rechazo y reintento: `decline` → el solicitante ve `DECLINED` con `retryAt`, el proveedor ya no la ve (lista y `GET messages` 404); reintento inmediato 409 `CONTACT_REQUEST_COOLDOWN`; mover `declinedAt` 24 h atrás con Prisma → reintento 201 y el proveedor la ve con los dos mensajes.
  - quien rechazó (con ficha propia) pide desde la ficha del otro → 409 `CONTACT_DECLINED_BY_YOU`, y `GET contact` → `DECLINED_BY_ME`.
  - tercero: `GET messages`, `accept`, `decline` → 404. Sin sesión: las cinco rutas nuevas 401; `GET /vendors/:id` sigue 200 sin sesión.
  - ficha despublicada: `POST` 404; una pendiente previa aún se acepta; una aceptada sigue escribiendo; `GET contact` con conversación → su estado.
  - relación previa (pareja ACTIVE + proveedor BOOKED de evento publicado) → nace `ACCEPTED`; la `EVENT_DIRECT` entre ellos es otra conversación.
  - autocontacto 422 y `GET contact` → `SELF`.
  - límite: 10 `POST` del mismo usuario (a fichas distintas o fallidos) y el 11.º 429; otro usuario desde la misma IP sigue pasando; un bearer con firma inválida → 401 sin gastar el cupo de nadie.
  - `GET /me/conversations` y `/me/rooms` no incluyen ninguna `PROFILE`.
  - socket: el proveedor recibe `message.created` + `contact.updated` al llegar la solicitud; el solicitante `contact.updated` al aceptar y al rechazar; tras rechazar, un reintento sí vuelve a llegar al proveedor.
- [ ] **Step 3:** Gate completo (`npm test`, `npm run build && npm run test:smoke`, `prisma migrate diff`); commit `feat(messaging): contacto desde el perfil en tiempo real`.
