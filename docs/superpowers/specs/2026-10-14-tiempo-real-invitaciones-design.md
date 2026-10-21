# Invitaciones en tiempo real y toasts

> Diseño aprobado en conversación el 2026-10-14. Rama `fix/pendientes-miembros` (desde
> `develop`) en `wedding-planner-backend` y `wedding-planner-frontend`. Continúa
> `2026-10-13-miembros-presupuesto-design.md`.

## 1. Problema

- Con la app abierta, un invitado no ve una invitación nueva (ni desaparece una cancelada)
  hasta recargar: `GET /me/invitations` sólo se pide al montar el layout.
- El backend ya tiene el canal (`/realtime`, sala `user:<id>`, `RealtimePort`), pero el
  frontend no tiene ningún cliente de Socket.IO.
- Un fallo al aceptar o rechazar desde el selector de eventos se muestra dentro del menú,
  que se cierra al pulsar: el usuario no lo ve. El frontend no tiene toasts.

## 2. Decisiones del usuario

- **Tiempo real ahora**, no recarga al abrir el selector.
- **Cliente general** (`lib/realtime`) reutilizable; de momento sólo lo usa el aviso de
  invitaciones. Los avisos de RSVP y las notificaciones quedan para después.
- **Qué avisa:** invitación **nueva** y invitación **cancelada** por el creador. Los cambios
  de membresía (rol, presupuesto, revocación de un ACTIVE) quedan fuera.
- **Errores del selector en un toast**, construido sobre **Radix Toast** como primitiva del
  sistema de diseño.

Fuera de alcance: avisos de RSVP y notificaciones en el frontend, cambios de membresía en
tiempo real, indicador de conexión, sustituir por toasts otros errores en línea.

## 3. Backend

### 3.1 Emisión por la cola `notifications`

Ruling C23 (ver `realtime.port.ts`): la petición HTTP persiste y encola; el **worker**
emite. Si Redis falla, la invitación ya está escrita y el aviso se reintenta.

- `events/application`: publica el contrato del trabajo, como hace `guests` con los suyos:
  ```ts
  export const TIPO_INVITACION_DE_MIEMBRO = 'invitacion-de-miembro'
  export interface JobInvitacionDeMiembro {
    userId: string        // el invitado: destinatario del aviso
    eventId: string
    cambio: 'nueva' | 'cancelada'
  }
  ```
- `InviteMemberUseCase`: además del correo, encola en `notifications` el trabajo con
  `cambio: 'nueva'`.
- `RevokeMemberUseCase`: si la membresía estaba **INVITED** (cancelar una invitación),
  encola con `cambio: 'cancelada'`. Revocar un ACTIVE no encola nada.
- `jobId`: `member-invitation-<membershipId>-<epochMs>` (como `rsvp-<invitationId>-<epochMs>`):
  dos cambios seguidos de la misma membresía no se deduplican entre sí.
- `NotificationProcessor`: nuevo `case TIPO_INVITACION_DE_MIEMBRO`; valida el payload con
  zod (`UnrecoverableError` si no cumple) y llama a
  `RealtimePort.emitirAUsuario(userId, 'member-invitation.changed', { eventId, cambio })`.
  No crea `Notification`: esa tabla es por evento y el invitado aún no tiene acceso.
- Regla de dependencia: `notifications` importa el contrato de `events/application` (como ya
  importa los de `guests/application`); `events` no importa nada de `notifications`.

### 3.2 Tests

- Unitarios: `InviteMemberUseCase` encola el aviso; `RevokeMemberUseCase` encola sólo al
  cancelar una INVITED (no al revocar una ACTIVE ni si la escritura falla).
- Worker: emite a `user:<id>` con el evento y la carga; payload roto → `UnrecoverableError`.
- E2E con `socket.io-client` real (ya es dependencia de desarrollo): el invitado conectado a
  `/realtime` recibe `member-invitation.changed` con `cambio: 'nueva'` al invitarle y
  `'cancelada'` al cancelar; otro usuario conectado no lo recibe.

## 4. Frontend

### 4.1 `src/lib/realtime.ts`

- Dependencia `socket.io-client@^4.8.3` (la versión del servidor).
- **Un socket por sesión** contra `${API_BASE_URL}/realtime`, `autoConnect: false`.
- `auth` como **función** que lee `useAuthStore.getState().accessToken` en cada intento:
  cada reconexión usa el token vigente.
- Ciclo de vida atado a `useAuthStore` (como `events-store`): conecta al pasar a
  `authenticated`; desconecta y descarta el socket al cambiar de usuario o al pasar a
  `anonymous`.
- Token: si la conexión se rechaza con `connect_error` `UNAUTHORIZED`, o el servidor
  desconecta (`io server disconnect`, que hace al caducar el token), llama a `refrescar()` de
  `api-client` y vuelve a conectar. Si `refrescar()` falla, la sesión se limpia (ya lo hace
  `refrescar`) y el socket se cierra por la suscripción anterior. Un único refresco en vuelo,
  sin bucles: si tras refrescar vuelve a fallar con `UNAUTHORIZED`, no reintenta más.
- API: `subscribe(evento, handler): () => void` y `onReconnect(handler): () => void`.
  Validar cada mensaje con zod es responsabilidad de quien se suscribe.

### 4.2 Invitaciones en tiempo real

- El layout (`app-layout.tsx`) se suscribe a `member-invitation.changed` (valida
  `{ eventId, cambio }` con zod) y llama a `useInvitationsStore.getState().reload()`.
- Al reconectar también recarga, por si se perdió un aviso durante el corte.

### 4.3 Toast (`src/components/ui/toast.tsx`)

- Primitiva sobre `@radix-ui/react-toast`, con el patrón de las demás (CVA + `forwardRef`,
  docblock, tokens del tema). **Sin variante roja**: el sistema resuelve los errores en
  oro/neutro (ver `design/primitives-inventory.md` #16 y `ErrorModal`). Lleva botón de cierre
  (`IconButton`), se cierra con Esc y con gesto, y desaparece sola a los 6 s.
- `ToastProvider` + `ToastViewport` montados una vez en el layout de la app; un store/hook
  (`useToasts` / `showToast(mensaje)`) para lanzarlos desde fuera de React (los stores).
- No existe en las 29 pantallas del export: se registra en `design/design-gaps.md` y en
  `design/primitives-inventory.md`, con la decisión y lo descartado (Sonner).
- Uso en esta entrega: el error de aceptar o rechazar una invitación desde el selector o
  desde `/dashboard` (`actionError` del store de invitaciones) se muestra en un toast y deja
  de pintarse dentro del menú.

### 4.4 Tests

- `realtime`: conecta con el token al autenticarse; se cierra al salir; refresca y reconecta
  tras `UNAUTHORIZED` y tras `io server disconnect`; no entra en bucle si el refresco no
  sirve; `subscribe` y `onReconnect` desuscriben.
- Layout: el aviso recarga las invitaciones; la reconexión recarga; un mensaje con forma
  inválida se ignora.
- Toast: se muestra, se anuncia (`role="status"`/región viva de Radix), se cierra con el
  botón y con Esc, y se va solo; un error de aceptar desde el selector abre un toast.
