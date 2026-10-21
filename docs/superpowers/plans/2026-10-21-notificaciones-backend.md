# Notificaciones (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rutas de notificaciones a nivel de usuario (`/me/notifications`) y dos productores nuevos de `Notification` (rebote/spam de invitación de boda; respuesta a invitación de equipo, sólo al dueño).

**Architecture:** Se amplía `NotificationRepository` con métodos por usuario (filtrados por membresía ACTIVE) y un controlador `/me/notifications`. El rebote crea la fila en la misma transacción que el avance de estado. La respuesta de equipo vive en `events`; para escribir la fila dentro de su transacción, `NOTIFICATION_PORT` se publica también desde un módulo nuevo sin dependencias (`NotificationWriterModule`) que `EventsModule` puede importar sin ciclo.

**Tech Stack:** NestJS 11, Prisma 6 / PostgreSQL 16, BullMQ, Zod, Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-10-21-notificaciones-design.md`

## Global Constraints

- Rama `feat/notificaciones` (ya creada desde `develop`); PR contra `develop`.
- Comentarios, docblocks y nombres de `describe`/`it` en español; strings de API en inglés. Prettier: sin `;`, comillas simples, ancho 100.
- Gate por tarea: `npm run typecheck && npm run lint && npx prettier --check .` verdes, y los tests que la tarea toca.
- Todo método nuevo en un puerto con doble: implementado en el doble **y** probado en su `*.paridad.test.ts`.
- Escrituras dentro de una `UnidadDeTrabajo` van con `clienteDe(this.prisma)`.
- Regla de destinatarios (spec §3): una notificación sólo va a quien tiene el permiso de la vista destino. RSVP y rebote → miembros ACTIVE (`COUPLE`|`PLANNER`, vista `/guests`); respuesta de equipo → sólo `Event.ownerId` (`OWNER`, vista `/settings`).
- Tipos de notificación: `guest.rsvp.updated` (existe), `guest.invitation.status` (sólo `BOUNCED`|`COMPLAINED` crean fila), `event.member.responded`.
- No cambiar el contrato de `notification.created` (`{ eventId, type }`).
- No borrar comentarios `DESIGN-GAP`.

## Review Focus

1. Usuario revocado de un evento con notificaciones no leídas → deja de verlas en `/me/notifications` y no cuentan en `unreadCount` (Task 1, paridad + e2e en Task 2).
2. `read-all` no marca notificaciones de eventos donde el usuario ya no es ACTIVE (se quedan como estaban; no se ven) y es idempotente (Task 1).
3. Webhook `bounced` repetido → una sola `Notification` por miembro, no dos (Task 3).
4. Un PLANNER o un segundo COUPLE del evento NO recibe `event.member.responded` (Task 4, e2e).
5. Fallo al crear la `Notification` del rebote o de la respuesta de equipo → deshace el cambio de estado/membresía (atomicidad; Task 3 y Task 4, unitarios con `fallarProximaCreacion`).

---

### Task 1: Métodos por usuario en `NotificationRepository`

**Files:**
- Modify: `src/modules/notifications/domain/notification.ts` (tipo `NotificacionConEvento`)
- Modify: `src/modules/notifications/application/notification.repository.ts`
- Modify: `src/modules/notifications/infrastructure/prisma-notification.repository.ts`
- Modify: `src/modules/notifications/infrastructure/notification.repository.fake.ts`
- Test: `src/modules/notifications/infrastructure/prisma-notification.repository.test.ts`
- Test: `src/modules/notifications/infrastructure/notification.repository.paridad.test.ts`
- Maybe modify: `prisma/schema.prisma` + migración (índice, ver Step 5)

**Interfaces:**
- Produces:
  ```ts
  // domain/notification.ts
  export interface NotificacionConEvento extends Notificacion {
    event: { id: string; name: string }
  }
  // application/notification.repository.ts — en NotificationRepository
  listarDeUsuario(userId: string, opciones: OpcionesListado): Promise<CursorPage<NotificacionConEvento>>
  contarNoLeidasDeUsuario(userId: string): Promise<number>
  /** Devuelve cuántas marcó. Sólo las visibles (evento con membresía ACTIVE). */
  marcarTodasLeidas(userId: string, ahora: Date): Promise<number>
  // fake
  registrarEvento(eventId: string, name: string): void
  ```
  "Visible" = `userId` coincide **y** existe `EventMembership { eventId, userId, status: 'ACTIVE' }`. En Prisma: `where: { userId, event: { memberships: { some: { userId, ...MIEMBRO_ACTIVO } } } }` (ajustar al nombre de la relación en `schema.prisma`), `include: { event: { select: { id: true, name: true } } }`. Mismo `ORDEN_ESTABLE` y cursor que `listar`. En el doble: visible si `userId` está en `registrarMiembros(eventId, …)` de ese evento; `name` sale de `registrarEvento`.

- [ ] **Step 1: Tests de paridad (fallan)** en `notification.repository.paridad.test.ts`, nuevo `describe('a nivel de usuario', …)`:
  - `it('listarDeUsuario mezcla eventos, más recientes primero, con el nombre del evento')` — usuario ACTIVE en E1 y E2, una notificación en cada uno → los dos devuelven los mismos items (`sinVolatiles`), cada uno con `event: { id, name }` correcto.
  - `it('listarDeUsuario y contarNoLeidasDeUsuario ignoran eventos donde ya no es ACTIVE')` — membresía REVOKED en E2 → sólo items de E1; contador = no leídas de E1.
  - `it('listarDeUsuario pagina igual en los dos con createdAt empatados')` — limite 1, 3 filas con el mismo `createdAt`.
  - `it('marcarTodasLeidas marca sólo las visibles y es idempotente')` — primera llamada devuelve N visibles, segunda 0; la de E2 (REVOKED) sigue con `readAt: null` (comprobar en Prisma con una lectura directa; en el doble con `filas`).
- [ ] **Step 2:** `npx vitest run src/modules/notifications/infrastructure/notification.repository.paridad.test.ts` → FAIL (métodos no existen).
- [ ] **Step 3:** Implementar los tres métodos en el puerto, el adaptador Prisma y el doble. Docblock en el puerto: por qué el filtro ACTIVE va en la consulta (spec §4.1: el revocado deja de verla; contador = lista) y que no es la decisión de permisos de `EventAccessService` sino el mismo filtro de datos que `destinatarios()`.
- [ ] **Step 4:** Repetir Step 2 → PASS. Añadir a `prisma-notification.repository.test.ts` un `it('listarDeUsuario no ve las de otro usuario')` y correrlo.
- [ ] **Step 5:** Índice: si `EXPLAIN` de `listarDeUsuario` en el contenedor de test hace seq scan con datos de prueba razonables, añadir `@@index([userId, createdAt])` a `Notification` y `npx prisma migrate dev --name notificaciones_por_usuario`. Si no, no tocar el schema. Anotar la decisión en el docblock del adaptador.
- [ ] **Step 6:** Gate (`typecheck`, `lint`, `prettier --check`).
- [ ] **Step 7: Commit** `feat(notifications): listar, contar y marcar todas a nivel de usuario`

---

### Task 2: `GET /me/notifications` y `POST /me/notifications/read-all`

**Files:**
- Create: `src/modules/notifications/application/list-my-notifications.use-case.ts`
- Create: `src/modules/notifications/application/mark-all-read.use-case.ts`
- Create: `src/modules/notifications/interfaces/my-notifications.controller.ts`
- Modify: `src/modules/notifications/notifications.module.ts` (controlador + casos de uso)
- Test: `src/modules/notifications/application/notifications.use-cases.test.ts`
- Test: `test/e2e/my-notifications.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1 (`listarDeUsuario`, `contarNoLeidasDeUsuario`, `marcarTodasLeidas`, `NotificacionConEvento`).
- Produces:
  ```ts
  class ListMyNotificationsUseCase { ejecutar(userId: string, o: OpcionesListado): Promise<CursorPage<NotificacionConEvento> & { unreadCount: number }> }
  class MarkAllReadUseCase { ejecutar(userId: string): Promise<void> }
  // HTTP
  GET  /me/notifications?cursor&limit&unread → 200
    { items: { id, type, payload, readAt: string|null, createdAt: string, event: { id, name } }[],
      nextCursor: string | null, unreadCount: number }
  POST /me/notifications/read-all → 204
  ```
  Controlador: `@UseGuards(JwtAuthGuard)`, `@Controller('me/notifications')`, query con `listarNotificacionesQuerySchema` vía `validarCon`, cursor ilegible → 400 como en `NotificationsController`. Mismo `exigirUsuario`. Sin `@LimiteDeRuta` (global). Ver `MyInvitationsController` como modelo de ruta `/me`.

- [ ] **Step 1: Unitarios (fallan)** en `notifications.use-cases.test.ts` contra `NotificationRepositoryEnMemoria`: `it('ListMyNotifications devuelve la página y el total global de no leídas')`, `it('MarkAllRead deja el contador global a 0')`.
- [ ] **Step 2:** `npx vitest run src/modules/notifications/application` → FAIL.
- [ ] **Step 3:** Implementar los dos casos de uso, el controlador y cablearlos en `NotificationsModule`.
- [ ] **Step 4:** Step 2 → PASS.
- [ ] **Step 5: E2E (`test/e2e/my-notifications.e2e.test.ts`)**, montado como `rsvp.e2e.test.ts` (`arrancarAppDeTest`, `startPostgres`); filas sembradas directamente con Prisma:
  - `it('sin token responde 401')`.
  - `it('lista las de todos mis eventos con su nombre, más recientes primero')` → `items[*].event.name` correcto, `unreadCount` = 2.
  - `it('tras revocarme de un evento no veo ni cuento sus notificaciones')` (revocar vía `DELETE /events/:id/members/:membershipId` con el dueño).
  - `it('read-all responde 204, deja unreadCount en 0 y repetirlo también es 204')`.
  - `it('limit=101 es 400')`, `it('un cursor ilegible es 400')`.
- [ ] **Step 6:** `npx vitest run test/e2e/my-notifications.e2e.test.ts` → PASS; gate.
- [ ] **Step 7: Commit** `feat(notifications): rutas /me/notifications y read-all`

---

### Task 3: Rebote y spam de invitación de boda crean `Notification`

**Files:**
- Modify: `src/modules/guests/application/invitation.repository.ts` (`InvitacionAvanzada.guestName`)
- Modify: `src/modules/guests/infrastructure/prisma-invitation.repository.ts` (`RETURNING g.name AS "guestName"`, `clienteDe(this.prisma).$queryRaw`)
- Modify: `src/modules/guests/infrastructure/invitation.repository.fake.ts` (`guestName`)
- Modify: `src/modules/guests/application/handle-delivery-event.use-case.ts`
- Modify: `src/modules/notifications/interfaces/notification.processor.ts`
- Test: `src/modules/guests/application/handle-delivery-event.use-case.test.ts` (o el fichero de tests existente del caso de uso)
- Test: `src/modules/notifications/interfaces/notification.processor.test.ts`
- Test: `test/e2e/resend-webhook.e2e.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface InvitacionAvanzada { invitationId: string; guestId: string; eventId: string; guestName: string }
  // payload persistido de guest.invitation.status (sólo BOUNCED | COMPLAINED)
  { guestId: string; guestName: string; invitationId: string; status: 'BOUNCED' | 'COMPLAINED' }
  ```
  `HandleDeliveryEventUseCase` inyecta además `NOTIFICATION_PORT` y `UNIDAD_DE_TRABAJO`. Dentro de `unidadDeTrabajo.ejecutar`: `actualizarEstadoPorMessageId` y, si `estado` es `BOUNCED`|`COMPLAINED`, `crearParaMiembros(eventId, TIPO_ESTADO_INVITACION, payloadPersistido)` por cada avanzada. Encolar sigue FUERA y DESPUÉS, igual que hoy. El job de socket (`JobEstadoInvitacion`) no cambia de forma.
  Worker: en `case TIPO_ESTADO_INVITACION`, `BOUNCED`|`COMPLAINED` → `avisos.avisarDeNotificacion(...)`; `DELIVERED` → `avisarDeCambio(...)` como hoy.
  Actualizar el docblock del caso de uso (ya no es "sin `Notification` detrás" para rebote/spam) y el de `BroadcastNoticeUseCase` ("hoy, el RSVP").

- [ ] **Step 1: Unitarios (fallan)** con `InvitationRepositoryEnMemoria`, `NotificationPortEnMemoria` y una unidad de trabajo falsa (la que ya usen los tests de `SubmitRsvpUseCase`):
  - `it('un rebote crea una notificación por miembro con el nombre del invitado')` → `creadas` con `tipo: 'guest.invitation.status'`, `payload.guestName`, `payload.status: 'BOUNCED'`.
  - `it('una queja de spam también crea notificación')` (`COMPLAINED`).
  - `it('una entrega correcta no crea notificación')` (`DELIVERED` → `creadas` vacío).
  - `it('un rebote repetido no crea una segunda notificación')` (segundo webhook igual → no avanza → `creadas.length` igual).
  - `it('si crear la notificación falla, el webhook falla y no se encola nada')` (`fallarProximaCreacion`).
- [ ] **Step 2:** Correr ese fichero → FAIL.
- [ ] **Step 3:** Implementar repo (Prisma + doble), caso de uso y wiring (`GuestsModule` ya importa `NotificationsModule`; `UNIDAD_DE_TRABAJO` es global).
- [ ] **Step 4:** Step 2 → PASS. Paridad de invitaciones: si existe un `*.paridad.test.ts` que cubra `actualizarEstadoPorMessageId`, añadir `guestName` a lo que compara.
- [ ] **Step 5: Worker** — en `notification.processor.test.ts`: `it('un rebote avisa con notification.created a cada miembro')` y `it('una entrega sólo avisa a la sala del evento')`. Implementar y pasar.
- [ ] **Step 6: E2E** en `resend-webhook.e2e.test.ts`: `it('un bounced firmado crea notificaciones visibles en /me/notifications')` y `it('un delivered no crea ninguna')`. Correr → PASS; gate.
- [ ] **Step 7: Commit** `feat(guests): el rebote y la queja de spam de una invitación notifican a los miembros`

---

### Task 4: La respuesta a una invitación de equipo notifica al dueño

**Files:**
- Modify: `src/modules/database/transaccion.ts` (helper `enTransaccion`)
- Create: `src/modules/notifications/notification-writer.module.ts`
- Modify: `src/modules/notifications/notifications.module.ts` (usar el writer en vez de su propio provider de `NOTIFICATION_PORT`, o seguir exportando el mismo — ver abajo)
- Modify: `src/modules/notifications/application/notification.port.ts` (`crearParaDueno`)
- Modify: `src/modules/notifications/infrastructure/prisma-notification.repository.ts`, `notification.port.fake.ts`
- Create: `src/modules/events/application/aviso-respuesta-miembro.ts`
- Modify: `src/modules/events/application/members.use-cases.ts` (`AcceptInvitationUseCase`, `DeclineInvitationUseCase`)
- Modify: `src/modules/events/infrastructure/prisma-event.repository.ts` (`aceptarInvitacion`, `revocarMembresia` usan `enTransaccion`)
- Modify: `src/modules/events/events.module.ts` (importa `NotificationWriterModule`)
- Modify: `src/modules/events/application/aviso-invitacion.ts` (docblock: ya no es cierto que `events` no importe nada de `notifications`)
- Modify: `src/modules/notifications/interfaces/notification.processor.ts`
- Test: `src/modules/events/application/members.use-cases.test.ts`, `src/modules/notifications/infrastructure/notification.repository.paridad.test.ts` (o el de `NotificationPort` si existe aparte), `notification.processor.test.ts`, `test/e2e/members.e2e.test.ts`, `src/modules/database/transaccion.test.ts` si existe

**Interfaces:**
- Produces:
  ```ts
  // database/transaccion.ts — reutiliza la transacción en curso o abre una
  export async function enTransaccion<T>(
    prisma: PrismaClient,
    trabajo: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>
  //   store activo → trabajo(store); si no → prisma.$transaction(tx => transaccionEnCurso.run(tx, () => trabajo(tx)))

  // notifications/application/notification.port.ts
  crearParaDueno(eventId: string, tipo: string, payload: unknown): Promise<void>
  //   una fila para Event.ownerId; evento inexistente → no crea nada

  // notifications/notification-writer.module.ts
  @Module({ providers: [{ provide: NOTIFICATION_PORT, useFactory: (p: PrismaService) => new PrismaNotificationRepository(p), inject: [PrismaService] }], exports: [NOTIFICATION_PORT] })
  export class NotificationWriterModule {}
  //   No importa NINGÚN otro módulo (PrismaService llega del DatabaseModule global): es lo que evita el ciclo con NotificationsModule → EventsModule.

  // events/application/aviso-respuesta-miembro.ts
  export const TIPO_RESPUESTA_DE_MIEMBRO = 'event.member.responded'
  export interface PayloadRespuestaDeMiembro { userId: string; fullName: string; response: 'ACCEPTED' | 'DECLINED' }
  export interface JobRespuestaDeMiembro { eventId: string; ownerId: string }
  export function jobIdDeRespuestaDeMiembro(eventId: string, userId: string, en: Date): string // `member-response-${eventId}-${userId}-${ms}`
  export async function encolarAvisoRespuesta(cola: QueuePort, registro: Logger, job: JobRespuestaDeMiembro, userId: string): Promise<void> // warn y se traga, como encolarAvisoInvitacion
  ```
  `AcceptInvitationUseCase` / `DeclineInvitationUseCase` inyectan además `NOTIFICATION_PORT`, `UNIDAD_DE_TRABAJO`, `QUEUE_PORT` y `USER_REPOSITORY` (para `fullName`; `EventsModule` ya importa `UsersModule`). Flujo: validar como hoy → `unidadDeTrabajo.ejecutar(() => { escribir membresía; si no escribió → SinInvitacionPendienteError; crearParaDueno(eventId, TIPO_RESPUESTA_DE_MIEMBRO, payload) })` → leer `ownerId` con `eventos.buscarPorId(eventId)` → `encolarAvisoRespuesta`.
  Worker: `case TIPO_RESPUESTA_DE_MIEMBRO` valida `{ eventId: z.guid(), ownerId: z.guid() }` (`satisfies z.ZodType<JobRespuestaDeMiembro>`) y llama `avisos.avisarAUsuario(ownerId, NOTIFICACION_CREADA, { eventId, type: TIPO_RESPUESTA_DE_MIEMBRO })`. Nada a la sala del evento.
  Docblock en `aviso-respuesta-miembro.ts`: la correspondencia tipo → permiso → vista (spec §3, `OWNER` → `/settings`), y por qué la fila va en la transacción y el aviso por cola.

- [ ] **Step 1: `enTransaccion`** — test (si hay `transaccion.test.ts`; si no, en el test de integración del repositorio de eventos): `it('dentro de una unidad de trabajo, enTransaccion usa la misma transacción: un fallo posterior deshace su escritura')`. Implementar. Cambiar `aceptarInvitacion` y `revocarMembresia` a `enTransaccion(this.prisma, async (tx) => …)`. Correr los tests de `prisma-event.repository` → PASS.
- [ ] **Step 2: `crearParaDueno`** — paridad (falla): `it('crearParaDueno crea UNA fila, para el dueño, en los dos')` y `it('crearParaDueno con un evento que no existe no crea nada en los dos')`. El doble necesita `registrarDueno(eventId, userId)`. Implementar en Prisma (`clienteDe`) y doble → PASS.
- [ ] **Step 3: `NotificationWriterModule`** + `EventsModule` lo importa. `NotificationsModule` sigue exportando `NOTIFICATION_PORT` para `guests` (dejarlo con su provider actual, `useExisting`). Correr `npm run lint:arch` → sin ciclos.
- [ ] **Step 4: Unitarios (fallan)** en `members.use-cases.test.ts`:
  - `it('aceptar crea event.member.responded ACCEPTED para el dueño con el nombre de quien acepta')`.
  - `it('rechazar crea event.member.responded DECLINED para el dueño')`.
  - `it('si crear la notificación falla, la invitación sigue pendiente')` (`fallarProximaCreacion`; con el doble de la unidad de trabajo, comprobar que el caso de uso propaga y que no se encoló nada).
  - `it('encola el aviso al dueño tras escribir')` y `it('si encolar falla, aceptar no falla')`.
- [ ] **Step 5:** Implementar el caso de uso → PASS.
- [ ] **Step 6: Worker** — `it('event.member.responded avisa sólo al dueño en su sala personal')`, `it('un job de respuesta con payload roto es irrecuperable')`. Implementar → PASS.
- [ ] **Step 7: E2E** en `members.e2e.test.ts` (dueño COUPLE + un PLANNER ACTIVE + invitado):
  - `it('al aceptar, el dueño ve event.member.responded en /me/notifications y el planner no')`.
  - `it('al rechazar, el dueño ve DECLINED y quien rechaza no ve nada')`.
  Correr → PASS.
- [ ] **Step 8:** `npm test` completo + gate.
- [ ] **Step 9: Commit** `feat(events): aceptar o rechazar una invitación de equipo notifica al dueño`

---

### Task 5: Cierre

- [ ] **Step 1:** `npm run build && npm run test:smoke` → PASS (el módulo nuevo pasa por `reescribir-alias.mjs`).
- [ ] **Step 2:** Si cambió `schema.prisma`, `npx prisma migrate diff` como en CI → sin diferencias pendientes.
- [ ] **Step 3:** Actualizar `docs/DATABASE.md` sólo si se añadió el índice. Commit si hubo cambios.
- [ ] **Step 4:** Push y PR contra `develop` describiendo las tres piezas y la regla de destinatarios.
