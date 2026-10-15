# Invitaciones en tiempo real y toasts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un invitado con la app abierta vea al instante una invitación nueva o cancelada, y que los errores de aceptar/rechazar se muestren en un toast.

**Architecture:** Backend: los casos de uso de invitar y cancelar encolan un trabajo en la cola `notifications`; su worker emite `member-invitation.changed` a la sala `user:<invitado>`. Frontend: un cliente de Socket.IO por sesión (`lib/realtime.ts`) que renueva el token; el layout recarga las invitaciones al recibir el aviso y al reconectar. Una primitiva `Toast` sobre Radix muestra los errores de invitaciones.

**Tech Stack:** Backend NestJS 11 + BullMQ + Socket.IO 4.8 + Vitest/Testcontainers. Frontend React 19, zustand 5, zod 4, `socket.io-client@^4.8.3`, `@radix-ui/react-toast`, Vitest + Testing Library.

**Spec:** `wedding-planner-backend/docs/superpowers/specs/2026-10-14-tiempo-real-invitaciones-design.md`

## Global Constraints

- Rama `fix/pendientes-miembros` en los dos repos (ya existe; no cambiar de rama). No hacer push ni merge.
- Backend: nunca commitear `.claude/settings.json` ni `.gitignore`. Reglas del CLAUDE.md del backend (capas, regla de dependencia, `DomainError`, comentarios en español).
- Frontend: CLAUDE.md del frontend (sin `<button>` crudo en `features/`, sin valores arbitrarios de Tailwind, tokens existentes, textos de UI en inglés, comentarios en español, respuestas validadas con zod).
- Evento de socket: `member-invitation.changed`, carga `{ eventId: string, cambio: 'nueva' | 'cancelada' }`.
- Trabajo de cola: nombre `invitacion-de-miembro` en la cola `notifications`, `jobId` `member-invitation-<membershipId>-<epochMs>`.
- Toast: sin variante roja (tonos oro/neutro del sistema), cierre con botón, con Esc y por gesto, duración 6000 ms.
- Gates de cada tarea: tests del área, `npm run typecheck`, `npm run lint`, `npx prettier --check .`; al final `npm test` completo en el repo tocado. Salida de tests sin avisos `act(...)`. Los tests de integración/e2e del backend necesitan Docker.
- Commits en español con el trailer de atribución del entorno.

## Review Focus

- **Encolar el aviso falla (Redis caído)** → la invitación o la cancelación ya están escritas y la petición responde 201/204; el fallo sólo se registra. → Task 1.
- **El access token caduca con la app abierta** → el servidor desconecta (`io server disconnect`); el cliente renueva el token y reconecta sin intervención. → Task 5.
- **El refresh ya no sirve (sesión caducada)** → el cliente no entra en bucle de reconexiones; la sesión se limpia y el socket queda cerrado. → Task 5.
- **Cambio de usuario en la misma pestaña** → el socket del usuario anterior se cierra y se abre uno con el token nuevo; nunca llegan avisos de otro usuario. → Task 5.
- **Un aviso con forma inesperada** (otra versión del backend) → se ignora sin romper la app. → Task 6.

---

## Backend

### Task 1: encolar el aviso al invitar y al cancelar

**Files:**
- Create: `src/modules/events/application/aviso-invitacion.ts`
- Modify: `src/modules/events/application/invite-member.use-case.ts` (+ `invite-member.use-case.test.ts`)
- Modify: `src/modules/events/application/members.use-cases.ts` (`RevokeMemberUseCase`) (+ `members.use-cases.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  export const TIPO_INVITACION_DE_MIEMBRO = 'invitacion-de-miembro'
  export const EVENTO_INVITACION_CAMBIADA = 'member-invitation.changed'
  export interface JobInvitacionDeMiembro { userId: string; eventId: string; cambio: 'nueva' | 'cancelada' }
  export function jobIdDeAvisoInvitacion(membershipId: string, en: Date): string // `member-invitation-${membershipId}-${en.getTime()}`
  ```
  `RevokeMemberUseCase` gana la dependencia `@Inject(QUEUE_PORT) cola: QueuePort` (segundo parámetro del constructor).

- [ ] **Step 1: Contrato.** `aviso-invitacion.ts`:

```ts
/**
 * Contrato del aviso en tiempo real de una invitación a un evento (spec
 * 2026-10-14 §3.1). Vive en `events/application` porque lo PRODUCEN los casos de
 * uso de este módulo; el worker de `notifications` lo importa de aquí, como ya
 * importa los de `guests/application`. `events` no importa nada de
 * `notifications`.
 */
export const TIPO_INVITACION_DE_MIEMBRO = 'invitacion-de-miembro'

/** Nombre del evento de Socket.IO que recibe el invitado en `user:<id>`. */
export const EVENTO_INVITACION_CAMBIADA = 'member-invitation.changed'

export interface JobInvitacionDeMiembro {
  /** El invitado: destinatario del aviso. */
  userId: string
  eventId: string
  cambio: 'nueva' | 'cancelada'
}

/**
 * Único por CAMBIO, no por membresía: invitar, cancelar y volver a invitar a la
 * misma membresía son tres avisos, y con `member-invitation-<id>` BullMQ
 * descartaría los dos últimos por jobId repetido. Con `-`, nunca `:` (ver
 * `EnqueueOptions.jobId`).
 */
export function jobIdDeAvisoInvitacion(membershipId: string, en: Date): string {
  return `member-invitation-${membershipId}-${en.getTime()}`
}
```

- [ ] **Step 2: Tests que fallan.** En `invite-member.use-case.test.ts`:

```ts
  it('encola el aviso en tiempo real para el invitado', async () => {
    await caso.ejecutar({ eventId: EVENTO, email: 'pedro@test.com', role: 'PLANNER', invitedById: anaId })
    const aviso = cola.encolados.find((e) => e.cola === 'notifications')
    expect(aviso).toMatchObject({
      nombre: 'invitacion-de-miembro',
      datos: { userId: pedroId, eventId: EVENTO, cambio: 'nueva' },
    })
    expect(aviso?.jobId).toMatch(/^member-invitation-[0-9a-f-]+-\d+$/)
  })

  it('si no se puede encolar el aviso, la invitación queda hecha igualmente', async () => {
    const original = cola.enqueue.bind(cola)
    cola.enqueue = (nombreCola, ...resto) =>
      nombreCola === 'notifications' ? Promise.reject(new Error('redis caído')) : original(nombreCola, ...resto)
    await expect(
      caso.ejecutar({ eventId: EVENTO, email: 'pedro@test.com', role: 'PLANNER', invitedById: anaId }),
    ).resolves.toMatchObject({ status: 'INVITED' })
  })
```

En `members.use-cases.test.ts` (construir `RevokeMemberUseCase` con `new RevokeMemberUseCase(repo, cola)`, `cola = new InMemoryQueueAdapter()`):

```ts
  it('cancelar una invitación pendiente encola el aviso de cancelada', async () => {
    await new RevokeMemberUseCase(repo, cola).ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA })
    expect(cola.encolados).toEqual([
      expect.objectContaining({
        cola: 'notifications',
        nombre: 'invitacion-de-miembro',
        datos: { userId: PIA, eventId: EVENTO, cambio: 'cancelada' },
      }),
    ])
  })

  it('revocar a un miembro ACTIVE no encola aviso de invitación', async () => {
    await repo.aceptarInvitacion(EVENTO, PIA)
    await new RevokeMemberUseCase(repo, cola).ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA })
    expect(cola.encolados).toEqual([])
  })

  it('si la escritura no se hace (carrera), no encola nada', async () => {
    repo.revocarMembresia = () => Promise.resolve(false)
    await expect(
      new RevokeMemberUseCase(repo, cola).ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA }),
    ).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
    expect(cola.encolados).toEqual([])
  })

  it('si no se puede encolar, la cancelación queda hecha igualmente', async () => {
    cola.enqueue = () => Promise.reject(new Error('redis caído'))
    await new RevokeMemberUseCase(repo, cola).ejecutar({ eventId: EVENTO, membershipId: piaId, actorId: ANA })
    expect(await repo.buscarMembresiaPorId(EVENTO, piaId)).toMatchObject({ status: 'REVOKED' })
  })
```

Ajusta el resto de usos de `new RevokeMemberUseCase(repo)` del fichero. Ejecuta
`npx vitest run src/modules/events/application` → FAIL.

- [ ] **Step 3: Implementación.**

`invite-member.use-case.ts`, tras encolar el correo (y con un `Logger` como en `submit-rsvp.use-case.ts`):

```ts
    // El aviso en tiempo real es una optimización de latencia (ver
    // `RealtimePort`): si Redis falla, la invitación ya está escrita y el
    // invitado la verá al recargar. Se registra y no se propaga, como el aviso
    // de RSVP.
    const aviso: JobInvitacionDeMiembro = { userId: invitado.id, eventId: evento.id, cambio: 'nueva' }
    try {
      await this.cola.enqueue('notifications', TIPO_INVITACION_DE_MIEMBRO, aviso, {
        jobId: jobIdDeAvisoInvitacion(membresia.id, new Date()),
      })
    } catch (error) {
      this.registro.warn(
        `Invitación hecha pero su aviso no se pudo encolar eventId=${evento.id} membershipId=${membresia.id}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }
```

`RevokeMemberUseCase`:

```ts
@Injectable()
export class RevokeMemberUseCase {
  private readonly registro = new Logger(RevokeMemberUseCase.name)

  constructor(
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  /**
   * Revocar a un ACTIVE y cancelar una INVITED son la misma escritura. Sólo la
   * cancelación avisa en tiempo real (spec 2026-10-14 §3.1): es lo que cambia
   * las invitaciones pendientes del invitado.
   */
  async ejecutar(datos: { eventId: string; membershipId: string; actorId: string }): Promise<void> {
    const membresia = await this.eventos.buscarMembresiaPorId(datos.eventId, datos.membershipId)
    exigirGestionable(membresia)
    const escrito = await this.eventos.revocarMembresia(datos.eventId, datos.membershipId, datos.actorId, 'revoked')
    if (!escrito) throw new MiembroNoEncontradoError()
    if (membresia.status !== 'INVITED') return

    const aviso: JobInvitacionDeMiembro = { userId: membresia.userId, eventId: datos.eventId, cambio: 'cancelada' }
    try {
      await this.cola.enqueue('notifications', TIPO_INVITACION_DE_MIEMBRO, aviso, {
        jobId: jobIdDeAvisoInvitacion(datos.membershipId, new Date()),
      })
    } catch (error) {
      this.registro.warn(
        `Invitación cancelada pero su aviso no se pudo encolar eventId=${datos.eventId} membershipId=${datos.membershipId}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }
  }
}
```

(`QUEUE_PORT`/`QueuePort` de `@/modules/queue/application/queue.port`; el `QueueModule` es global, así que el módulo no necesita cambios.)

- [ ] **Step 4: Verlo pasar.** `npx vitest run src/modules/events` → PASS; `npx vitest run test/e2e/members.e2e.test.ts` → PASS (el trabajo nuevo va a una cola cuyo worker todavía lo rechaza como desconocido; es inocuo hasta la Task 2).

- [ ] **Step 5: Gates y commit.**

```bash
npm run typecheck && npm run lint && npx prettier --check .
git add src/modules/events
git commit -m "feat: encolar el aviso en tiempo real al invitar y al cancelar una invitación"
```

---

### Task 2: el worker emite el aviso al invitado

**Files:**
- Modify: `src/modules/notifications/interfaces/notification.processor.ts` (+ `notification.processor.test.ts`)
- Test: `test/e2e/realtime.e2e.test.ts` (o un fichero nuevo `test/e2e/realtime-invitaciones.e2e.test.ts` si el existente queda demasiado grande; reutiliza sus helpers de conexión)

**Interfaces:**
- Consumes: `TIPO_INVITACION_DE_MIEMBRO`, `EVENTO_INVITACION_CAMBIADA`, `JobInvitacionDeMiembro` de `@/modules/events/application/aviso-invitacion` (Task 1).
- Produces: evento Socket.IO `member-invitation.changed` con `{ eventId, cambio }` en `user:<userId>`.

- [ ] **Step 1: Tests que fallan** en `notification.processor.test.ts`:

```ts
  describe('invitacion-de-miembro', () => {
    const userId = randomUUID()

    it.each(['nueva', 'cancelada'] as const)('emite %s al invitado y sólo a él', async (cambio) => {
      await procesador.process(job('invitacion-de-miembro', { userId, eventId, cambio }))
      expect(realtime.emitidas).toEqual([
        { destino: { userId }, tipo: 'member-invitation.changed', payload: { eventId, cambio } },
      ])
    })

    it('no emite nada más que lo validado', async () => {
      await procesador.process(job('invitacion-de-miembro', { userId, eventId, cambio: 'nueva', extra: 'x' }))
      expect(realtime.emitidas[0]?.payload).toEqual({ eventId, cambio: 'nueva' })
    })

    it('un payload roto no se reintenta', async () => {
      await expect(
        procesador.process(job('invitacion-de-miembro', { userId, eventId, cambio: 'otra' })),
      ).rejects.toBeInstanceOf(UnrecoverableError)
      expect(realtime.emitidas).toEqual([])
    })
  })
```

`npx vitest run src/modules/notifications` → FAIL (job desconocido).

- [ ] **Step 2: Implementación.** En `notification.processor.ts`:

```ts
const invitacionDeMiembroSchema = z.object({
  userId: z.guid(),
  eventId: z.guid(),
  cambio: z.enum(['nueva', 'cancelada']),
}) satisfies z.ZodType<JobInvitacionDeMiembro>
```

y en el `switch`:

```ts
      case TIPO_INVITACION_DE_MIEMBRO: {
        const { userId, eventId, cambio } = leer(invitacionDeMiembroSchema, job)
        // Al usuario, no al evento: el invitado aún no tiene acceso y no está en
        // `event:<id>`. No se crea `Notification` (spec 2026-10-14 §3.1).
        await this.avisos.avisarAUsuario(userId, EVENTO_INVITACION_CAMBIADA, { eventId, cambio })
        return
      }
```

Añade a `BroadcastNoticeUseCase`:

```ts
  /** Aviso directo a un usuario, sin persistir: lo que pasa le atañe sólo a él. */
  async avisarAUsuario(userId: string, tipo: string, payload: unknown): Promise<void> {
    await this.realtime.emitirAUsuario(userId, tipo, payload)
  }
```

(con su test en `notifications.use-cases.test.ts`: emite a `{ userId }` y nada a eventos). Actualiza el docblock del worker con el tipo nuevo.

- [ ] **Step 3: E2E con un cliente real.** Siguiendo los helpers de `test/e2e/realtime.e2e.test.ts` (conexión con `io(`${url}/realtime`, { auth: { token }, reconnection: false })`), añade:

```ts
  it('el invitado conectado recibe member-invitation.changed al invitarle y al cancelar, y otro no', async () => {
    // ana crea evento publicado; pia y otro registrados y conectados a /realtime
    const recibidosPia: unknown[] = []
    const recibidosOtro: unknown[] = []
    socketPia.on('member-invitation.changed', (p: unknown) => recibidosPia.push(p))
    socketOtro.on('member-invitation.changed', (p: unknown) => recibidosOtro.push(p))

    const r = await request(url).post(`/events/${evento}/members`)
      .set({ Authorization: `Bearer ${ana.accessToken}` }).send({ email: pia.email, role: 'PLANNER' }).expect(201)
    await vi.waitFor(() => expect(recibidosPia).toEqual([{ eventId: evento, cambio: 'nueva' }]), { timeout: 10_000 })

    await request(url).delete(`/events/${evento}/members/${(r.body as { id: string }).id}`)
      .set({ Authorization: `Bearer ${ana.accessToken}` }).expect(204)
    await vi.waitFor(
      () => expect(recibidosPia).toEqual([{ eventId: evento, cambio: 'nueva' }, { eventId: evento, cambio: 'cancelada' }]),
      { timeout: 10_000 },
    )
    expect(recibidosOtro).toEqual([])
  })
```

(adapta nombres y setup a los del fichero; si el fichero no registra usuarios con `email`, añade el campo como hacen otros e2e).

- [ ] **Step 4: Verlo pasar.** `npx vitest run src/modules/notifications test/e2e/realtime.e2e.test.ts` → PASS; `npm test` → PASS.

- [ ] **Step 5: Gates y commit.**

```bash
npm run typecheck && npm run lint && npx prettier --check .
git add src/modules/notifications test/e2e
git commit -m "feat: el worker de notificaciones avisa al invitado en tiempo real"
```

---

## Frontend

### Task 3: primitiva `Toast` y `showToast`

**Files:**
- Modify: `package.json` / lockfile (`npm install @radix-ui/react-toast` — versión 1.x estable actual)
- Create: `src/components/ui/toast.tsx` (+ `toast.test.tsx`)
- Create: `src/lib/toast-store.ts` (+ `toast-store.test.ts`)
- Create: `src/app/toaster.tsx` (+ `toaster.test.tsx`)
- Modify: `src/app/app-layout.tsx` (monta `<Toaster />`)
- Modify: `design/design-gaps.md`, `design/primitives-inventory.md`

**Interfaces:**
- Produces:
  ```ts
  // src/lib/toast-store.ts
  export interface ToastItem { id: number; message: string }
  export function showToast(message: string): void
  export const useToastStore // zustand: { toasts: ToastItem[]; dismiss(id: number): void }
  // src/components/ui/toast.tsx
  export const ToastProvider, ToastViewport, Toast, ToastDescription, ToastClose
  // src/app/toaster.tsx
  export function Toaster(): JSX.Element
  ```

- [ ] **Step 1: Store con test que falla.** `toast-store.test.ts`: `showToast('A')` añade `{ id, message: 'A' }`; dos llamadas dan ids distintos y orden de llegada; `dismiss(id)` lo quita; el store se vacía al cambiar de usuario en `useAuthStore` (mismo patrón de suscripción que `events-store.ts`).

- [ ] **Step 2: Store.** `toast-store.ts` con zustand: `toasts`, contador de ids en módulo, `showToast` usable fuera de React (`useToastStore.getState()`), `dismiss`, limpieza en cambio de usuario. Docblock: por qué existe (avisos que no tienen un sitio visible en la pantalla, p. ej. un menú que se cierra al pulsar) y que no sustituye los errores en línea de los formularios.

- [ ] **Step 3: Primitiva con test que falla.** `toast.test.tsx`, renderizando `ToastProvider` + `Toast open` + `ToastViewport`:
  - el texto se anuncia en una región viva (`getByRole('status')` o la que Radix exponga; compruébalo en el DOM y fija esa);
  - el botón de cierre (`ToastClose`, `aria-label="Dismiss"`) llama a `onOpenChange(false)`;
  - `Escape` con foco en el toast lo cierra;
  - `duration` por defecto 6000: con `vi.useFakeTimers()`, a los 6000 ms `onOpenChange(false)`.

- [ ] **Step 4: Primitiva.** `toast.tsx` sobre `@radix-ui/react-toast`, con el patrón de `tooltip.tsx`/`modal.tsx` (forwardRef, `cn`, CVA si hay variantes — aquí una sola). Estética: superficie neutra (`bg-surface-raised` o el token de tarjeta existente), borde `border-line`, texto `text-ink`, acento en oro (`text-primary`) para el icono si lo hubiera, sombra existente; **sin rojo**. Cierre con `IconButton` (variante discreta existente) y el icono de cierre que ya use el repo (busca `CloseIcon` en `src/features/profile/profile-icons.tsx` o `src/components/layout/nav-list.tsx` y reutiliza/extrae a `components/ui` si hace falta, sin duplicar el SVG). `ToastViewport` fijo abajo a la derecha en escritorio y a todo el ancho con margen de 16 px en móvil, `z-` existente por encima de modales. Sólo clases que existan en `tailwind.config.ts`.

- [ ] **Step 5: `Toaster` con test.** `toaster.tsx` renderiza `useToastStore().toasts` dentro de `ToastProvider duration={6000}` + `ToastViewport`, cada uno `open` y con `onOpenChange={(o) => !o && dismiss(id)}`. Test: `showToast('Hola')` → aparece "Hola"; cerrar → desaparece del store. Monta `<Toaster />` una vez en `AppLayout` (fuera del `<Outlet />`).

- [ ] **Step 6: Documentar.** `design/primitives-inventory.md`: fila `Toast` (sin instancia en las 29 pantallas; decisión Radix frente a Sonner por coherencia con Dialog/DropdownMenu/Tooltip; sin severidades, como `Banner`). `design/design-gaps.md`: entrada que registra que el export no tiene toast, qué se hizo y por qué (menú que se cierra al pulsar).

- [ ] **Step 7: Gates y commit.**

```bash
npx vitest run src/components/ui/toast.test.tsx src/lib/toast-store.test.ts src/app
npm run typecheck && npm run lint && npx prettier --check .
git add -A src design package.json package-lock.json
git commit -m "feat: primitiva Toast sobre Radix y showToast para avisos sin sitio en pantalla"
```

---

### Task 4: errores de invitaciones en un toast

**Files:**
- Modify: `src/lib/invitations-store.ts` (+ test)
- Modify: `src/app/event-switcher.tsx` (+ test), `src/app/app-layout.tsx` (+ test)
- Modify: `src/features/members/pending-invitations.tsx` (+ test), `src/app/dashboard-redirect.tsx` (+ test) si muestran el error

**Interfaces:**
- Consumes: `showToast(message)` (Task 3).
- Produces: `useInvitationsStore` sin `actionError`; `EventSwitcher` sin prop `invitationError`.

- [ ] **Step 1: Tests que fallan.**
  - Store: con la API de aceptar o rechazar fallando con un error no-404, se llama a `showToast` (mock de `./toast-store`) con el mensaje de `errorMessage(error, "We couldn't update the invitation. Please try again.")`; un 404 no muestra toast; un fallo de otra sesión (tras `clear()`) no muestra toast; sigue relanzando como hoy.
  - Switcher: ya no pinta ningún `role="alert"`.
  - `PendingInvitations`: al fallar, no pinta `role="alert"` en la tarjeta (el aviso es el toast) y los botones vuelven a estar disponibles.
  - Layout: aceptar desde el selector con un 500 → aparece el toast con el mensaje (integración con `<Toaster />`).

- [ ] **Step 2: Implementación.** Sustituye `actionError` por la llamada a `showToast` en el `resolver` del store (manteniendo la guarda de sesión), elimina el estado, la prop `invitationError` del switcher, su pintado y su paso desde el layout, y el error en línea de `PendingInvitations` (su docblock pasa a decir que el fallo lo avisa el toast). Actualiza los tests que dependían de `actionError`/`invitationError`.

- [ ] **Step 3: Gates y commit.**

```bash
npx vitest run src/lib src/app src/features/members
npm run typecheck && npm run lint && npx prettier --check .
git add -A src
git commit -m "feat: los errores al aceptar o rechazar una invitación se avisan con un toast"
```

---

### Task 5: cliente de tiempo real (`src/lib/realtime.ts`)

**Files:**
- Modify: `package.json` / lockfile (`npm install socket.io-client@^4.8.3`)
- Modify: `src/lib/api-client.ts` (exportar `API_BASE_URL`), `src/lib/auth-store.ts` (exportar `refrescarEntreDocumentos`)
- Create: `src/lib/realtime.ts` (+ `realtime.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  export type Unsubscribe = () => void
  export function subscribe(evento: string, handler: (payload: unknown) => void): Unsubscribe
  export function onReconnect(handler: () => void): Unsubscribe
  ```

- [ ] **Step 1: Tests que fallan.** `realtime.test.ts`, con `vi.mock('socket.io-client')` devolviendo un socket falso (EventEmitter mínimo con `connect`, `disconnect`, `on`, `onAny`, `auth`, `connected`, y helpers del test para emitir `connect`, `connect_error`, `disconnect` y eventos del servidor):
  1. Al pasar `useAuthStore` a `authenticated`, se crea el socket contra `${API_BASE_URL}/realtime` con `autoConnect: false` y se llama a `connect()`; `auth` es una función que entrega `{ token }` con el `accessToken` vigente en ese momento (cámbialo entre dos llamadas y compruébalo).
  2. Al pasar a `anonymous` o cambiar de `user.id`, el socket se desconecta; tras cambiar de usuario se crea uno nuevo.
  3. `connect_error` con `data.code === 'UNAUTHORIZED'` → se llama a `refrescarEntreDocumentos` (mock) y después a `connect()`.
  4. `disconnect` con `'io server disconnect'` → refresca y reconecta.
  5. Si tras refrescar vuelve a llegar `UNAUTHORIZED` antes de una conexión correcta, no se refresca otra vez ni se reconecta (sin bucle). Una conexión correcta rearma el mecanismo.
  6. Si `refrescarEntreDocumentos` rechaza, no se reconecta.
  7. `subscribe('x', h)` recibe los eventos `x` del servidor; tras el `Unsubscribe`, no.
  8. `onReconnect(h)` se llama en cada `connect` salvo el primero de la sesión; tras desuscribir, no.

- [ ] **Step 2: Implementación.** Esquema:

```ts
import { io, type Socket } from 'socket.io-client'
import { API_BASE_URL } from './api-client'
import { refrescarEntreDocumentos, useAuthStore } from './auth-store'

/**
 * Canal de tiempo real (spec 2026-10-14 §4.1): UN socket por sesión contra
 * `/realtime`. El servidor autentica en el handshake y desconecta al caducar el
 * access token; aquí se renueva el token y se reconecta. Quien se suscribe valida
 * cada mensaje con zod: este módulo no conoce la forma de ningún evento.
 */
export type Unsubscribe = () => void

const handlers = new Map<string, Set<(payload: unknown) => void>>()
const reconexiones = new Set<() => void>()
let socket: Socket | null = null
let conectadoAntes = false
let refrescoUsado = false

/**
 * Un único refresco por corte: si tras renovar el token el servidor vuelve a
 * rechazar, la sesión ya no sirve y reintentar sería un bucle. Una conexión
 * correcta lo rearma.
 */
function renovar(s: Socket): void {
  if (refrescoUsado) return
  refrescoUsado = true
  refrescarEntreDocumentos().then(
    () => {
      // Sólo si sigue siendo el socket de la sesión actual.
      if (socket === s) s.connect()
    },
    // `refrescar` ya limpia la sesión al fallar; la suscripción de abajo cierra el socket.
    () => undefined,
  )
}

function conectar(): void {
  const s = io(`${API_BASE_URL}/realtime`, {
    autoConnect: false,
    // Función y no objeto: cada intento (también las reconexiones automáticas)
    // lee el token vigente.
    auth: (cb) => cb({ token: useAuthStore.getState().accessToken ?? '' }),
  })
  s.onAny((evento: string, payload: unknown) => {
    for (const handler of handlers.get(evento) ?? []) handler(payload)
  })
  s.on('connect', () => {
    refrescoUsado = false
    if (conectadoAntes) for (const handler of reconexiones) handler()
    conectadoAntes = true
  })
  s.on('connect_error', (error: Error & { data?: { code?: string } }) => {
    if (error.data?.code === 'UNAUTHORIZED') renovar(s)
  })
  s.on('disconnect', (razon: string) => {
    // El servidor desconecta al caducar el access token (ver NotificationsGateway).
    if (razon === 'io server disconnect') renovar(s)
  })
  socket = s
  s.connect()
}

function desconectar(): void {
  socket?.disconnect()
  socket = null
  conectadoAntes = false
  refrescoUsado = false
}

export function subscribe(evento: string, handler: (payload: unknown) => void): Unsubscribe {
  const conjunto = handlers.get(evento) ?? new Set<(payload: unknown) => void>()
  conjunto.add(handler)
  handlers.set(evento, conjunto)
  return () => {
    conjunto.delete(handler)
  }
}

export function onReconnect(handler: () => void): Unsubscribe {
  reconexiones.add(handler)
  return () => {
    reconexiones.delete(handler)
  }
}

// Atado a la sesión, como `events-store`: un usuario nuevo, un socket nuevo.
useAuthStore.subscribe((state, previous) => {
  if (state.user?.id === previous.user?.id && state.status === previous.status) return
  desconectar()
  if (state.status === 'authenticated' && state.user !== null) conectar()
})

// Si la sesión ya estaba abierta al importar el módulo (tests, HMR).
const inicial = useAuthStore.getState()
if (inicial.status === 'authenticated' && inicial.user !== null) conectar()
```

Exporta `API_BASE_URL` (en `api-client.ts`) y `refrescarEntreDocumentos` (en `auth-store.ts`) con un docblock que diga que `realtime.ts` también los usa. Ajusta los tipos del callback de `auth` y de los eventos a lo que declare `socket.io-client` si el compilador lo pide, sin `any`.

- [ ] **Step 3: Gates y commit.**

```bash
npx vitest run src/lib/realtime.test.ts src/lib
npm run typecheck && npm run lint && npx prettier --check .
git add -A src package.json package-lock.json
git commit -m "feat: cliente de tiempo real por sesión con renovación del token"
```

---

### Task 6: el layout recarga las invitaciones en tiempo real

**Files:**
- Modify: `src/app/app-layout.tsx` (+ `app-layout.test.tsx`)

**Interfaces:**
- Consumes: `subscribe`, `onReconnect` (Task 5); `useInvitationsStore.getState().reload()`.

- [ ] **Step 1: Tests que fallan** (mock de `../lib/realtime` que guarda los handlers registrados):
  - un `member-invitation.changed` con `{ eventId: 'ev-9', cambio: 'nueva' }` llama a `reload()` de invitaciones;
  - un mensaje con forma inválida (`{ eventId: 1 }`, `null`, `{ cambio: 'otra' }`) no llama a `reload()` ni lanza;
  - un `onReconnect` llama a `reload()`;
  - al desmontar el layout se desuscriben los dos.

- [ ] **Step 2: Implementación.** En `AppLayout`, un `useEffect` sin dependencias que:

```ts
const avisoInvitacionSchema = z.object({ eventId: z.string(), cambio: z.enum(['nueva', 'cancelada']) })

useEffect(() => {
  const recargar = () => void useInvitationsStore.getState().reload()
  const quitarAviso = subscribe('member-invitation.changed', (payload) => {
    // Otra versión del backend o un mensaje roto: se ignora.
    if (avisoInvitacionSchema.safeParse(payload).success) recargar()
  })
  // Al reconectar se recarga por si se perdió un aviso durante el corte.
  const quitarReconexion = onReconnect(recargar)
  return () => { quitarAviso(); quitarReconexion() }
}, [])
```

con un comentario que remita a la spec. Actualiza el docblock de `AppLayout`.

- [ ] **Step 3: Gates y commit.**

```bash
npx vitest run src/app
npm test && npm run typecheck && npm run lint && npx prettier --check .
git add -A src
git commit -m "feat: las invitaciones se recargan al recibir el aviso en tiempo real y al reconectar"
```

---

### Task 7: verificación manual

- [ ] Arranca el backend (`npm run dev` con `.env` y Docker) y el frontend (`npm run dev`). Con dos navegadores (creador e invitado con sesión): invitar → la invitación aparece sola en el selector del invitado; cancelar → desaparece; forzar un 500 al aceptar (p. ej. parando la base de datos) → toast con el mensaje. Anota el resultado en el resumen final; si algo falla, es un hallazgo.
