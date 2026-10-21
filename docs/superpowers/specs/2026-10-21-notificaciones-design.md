# Notificaciones: campana global en la AppNavbar

Fecha: 2026-10-21. Abarca backend (`wedding-planner-backend`) y frontend
(`wedding-planner-frontend`). Continúa la spec 2026-10-14 de invitaciones en
tiempo real, que dejó las notificaciones fuera de alcance.

## 1. Intención

Quien planifica varias bodas a la vez (pareja o planner) se entera hoy de lo
que pasa en sus eventos sólo si está mirando la pantalla correcta. Queremos una
**campana en la barra superior, visible en toda la app con sesión**, que:

- cuente las notificaciones no leídas de **todos** los eventos del usuario,
- liste las recientes diciendo de qué evento es cada una,
- al hacer clic **lleve al evento correcto** (y a la sección que toca) y la
  marque como leída,
- se actualice en tiempo real sin recargar.

Lo que el usuario decidió: alcance global (todos los eventos) y que el clic
lleve al evento. El resto de este documento es propuesta mía, aceptada en
conjunto en la conversación ("se ve bien, adelante"); los puntos marcados
**[decisión de diseño]** son llamadas mías que conviene revisar.

## 2. Objetivos, no objetivos, anti-objetivos

**Objetivos**

- Campana con contador global de no leídas en la `AppNavbar`, en cualquier
  vista bajo `AppLayout` (también `/dashboard` y `/profile`).
- Panel desplegable con las últimas notificaciones de todos los eventos,
  paginado por cursor, con "marcar todas como leídas".
- Clic → marca leída + navega al destino de esa notificación.
- Tiempo real: el aviso `notification.created` (ya existe, va a `user:<id>`)
  refresca contador y lista; al reconectar el socket, también.
- Tres tipos de notificación persistida en esta ronda (§3).

**No objetivos**

- Notificaciones para vendors (no son miembros; hoy 403 y así sigue).
- Notificaciones por correo o push del navegador.
- Preferencias por tipo (silenciar, etc.).
- Página completa `/notifications`; el panel con "cargar más" basta.
- Feed de actividad (ediciones de invitados, gastos, mesas, cronograma por
  compañeros de equipo): es otro producto.

**Anti-objetivos** (lo que haría fallar esto aunque "funcione")

- Que un clic aterrice en un 404/403: p. ej. una notificación de un evento del
  que ya te sacaron.
- Ruido: avisar de cosas que no piden atención (un correo ENTREGADO bien).
- Contador que miente: el número de la campana tiene que casar con lo que se
  ve al abrirla.
- Duplicar la regla de acceso a eventos fuera de `EventAccessService`.

## 3. Qué procesos notifican (esta ronda)

Análisis completo hecho en la conversación; resumen.

**Regla de destinatarios (requisito del usuario):** una notificación sólo va a
quien tiene permiso para ver la información de la vista a la que lleva su
clic. Cada tipo declara el permiso de su vista destino (los de
`PermisoDeEvento`, tal como los exige la ruta de la API que esa vista lee), y
los destinatarios son los miembros ACTIVE que lo tienen. Comprobado contra el
código el 2026-10-21:

- `/events/:id/guests` lee `GET /events/:id/guests`, que exige
  `COUPLE`|`PLANNER`. Todo miembro ACTIVE tiene uno de los dos (`EventRole`
  sólo tiene esos valores), así que "miembros ACTIVE" ya cumple la regla.
- `/events/:id/settings` (la sección Members) lee `GET /events/:id/members`,
  que exige `OWNER`; la pantalla no pinta nada para quien no es dueño
  (`event-settings-screen.tsx`). Sólo el dueño puede recibir notificaciones de
  equipo.

Si en el futuro un rol pierde acceso a una vista, el tipo que lleva a ella
tiene que estrechar sus destinatarios: hay que dejar esa correspondencia
tipo → permiso → ruta escrita en un docblock junto a los tipos, y un test por
tipo que compruebe que un usuario sin el permiso no recibe la fila.

| Proceso | Hoy | Esta ronda | Permiso de la vista | Destinatarios | Destino del clic |
|---|---|---|---|---|---|
| Invitado responde RSVP (`guest.rsvp.updated`) | `Notification` + socket | sin cambios | `COUPLE`\|`PLANNER` | miembros ACTIVE | `/events/:id/guests` |
| Invitación de boda REBOTA o se marca como spam (`guest.invitation.status` con `BOUNCED`/`COMPLAINED`) | sólo socket a la sala del evento | **nueva `Notification`** | `COUPLE`\|`PLANNER` | miembros ACTIVE | `/events/:id/guests` |
| Un invitado al equipo ACEPTA o RECHAZA (`AcceptInvitationUseCase`, `DeclineInvitationUseCase`) | nada | **nueva `Notification`** | `OWNER` | **sólo el dueño** del evento (`Event.ownerId`) | `/events/:id/settings` |

**[decisión de diseño]** Estos tres y no más: los tres son cosas que hace otra
persona o un sistema externo, en diferido, y piden atención. Descartados con
motivo: `DELIVERED` (ruido); revocación de un miembro (el revocado pierde
acceso al evento y no podría ni leer ni navegar a la notificación — rompe el
anti-objetivo 1); reservar/cancelar vendor (lo hace el owner, valor bajo para
el resto); CRUD de compañeros (feed de actividad).

### Payloads (`type` → `payload`)

El `payload` es JSON sin forma común (ver `domain/notification.ts`). Debe
bastar para pintar el texto **sin otra petición**:

- `guest.rsvp.updated` → `{ guestId, guestName, rsvp: 'CONFIRMED'|'DECLINED' }` (existe).
- `guest.invitation.status` → `{ guestId, guestName, invitationId, status: 'BOUNCED'|'COMPLAINED' }`.
  Hoy el job no lleva `guestName`: `actualizarEstadoPorMessageId` tendrá que
  devolverlo (o leerse aparte) para la `Notification`. El job de socket puede
  seguir como está.
- `event.member.responded` → `{ userId, fullName, response: 'ACCEPTED'|'DECLINED' }`
  **[decisión de diseño: nombre del tipo]**.

## 4. Backend

### 4.1 Rutas nuevas, a nivel de usuario

Nuevo controlador en `notifications/interfaces/`, `JwtAuthGuard`, sin
`EventAccessGuard` (no hay `:eventId`):

- `GET /me/notifications?cursor&limit&unread` → misma forma que la ruta por
  evento más el evento de cada fila:
  ```ts
  {
    items: { id, type, payload, readAt, createdAt, event: { id, name } }[]
    nextCursor: string | null
    unreadCount: number // global, todas las no leídas visibles
  }
  ```
  Mismo esquema de query que `listarNotificacionesQuerySchema` (reutilizarlo).
- `POST /me/notifications/read-all` → 204. Marca leídas todas las visibles.
  Idempotente.
- Marcar UNA: se reutiliza `POST /events/:eventId/notifications/:id/read`
  (cada item trae su `event.id`). **[decisión de diseño]** No se duplica la
  ruta en `/me`.

**Visibilidad (la regla clave):** una fila es visible en `/me` si su `userId`
es el usuario **y** el usuario tiene membresía **ACTIVE** en ese evento hoy.
Así el revocado deja de verla (anti-objetivo 1) y el contador casa con la
lista. Se aplica igual a `listar`, `contarNoLeidas` y `read-all` a nivel de
usuario.

¿Cómo, sin duplicar la regla de acceso? La pertenencia ACTIVE es un filtro de
datos (un `JOIN`/`EXISTS` sobre `event_memberships` con `status = 'ACTIVE'`),
el mismo criterio que ya usa `destinatarios()` del repositorio; no es la
decisión de permisos de `EventAccessService`. Si al builder le parece que sí lo
es, lo alternativo es pedir los ids de eventos accesibles al puerto público de
`EventsModule` y filtrar por ellos — decisión del builder, anotándola.

Nombre del evento: hay que exponerlo (columna de `Event`; confirmar cuál en
`docs/DATABASE.md`). Ojo con eventos borrados: `onDelete: Cascade` ya se
lleva sus notificaciones.

Paginación: mismo cursor (`createdAt`, `id`) que la ruta por evento; el índice
`@@index([userId, readAt])` ayuda al contador. Si el plan de consulta del
listado global lo pide, añadir `@@index([userId, createdAt])` con su migración
(CI falla si `schema.prisma` cambia sin ella).

Límite de ritmo: el global basta (como la ruta por evento).

Puerto: ampliar `NotificationRepository` con `listarDeUsuario`,
`contarNoLeidasDeUsuario`, `marcarTodasLeidas` (o nombres equivalentes), con
**doble y test de paridad** (es lo que exige el repo al añadir métodos a un
puerto con doble).

### 4.2 Productores nuevos

**Rebote/spam.** En `HandleDeliveryEventUseCase`, por cada invitación que
avanza a `BOUNCED` o `COMPLAINED`, crear la `Notification` con
`NOTIFICATION_PORT.crearParaMiembros` (guests ya lo inyecta en el RSVP). El
socket sigue igual, pero para que la campana se entere el worker debe emitir
`notification.created` a los miembros en esos dos estados: pasar por
`avisarDeNotificacion` en vez de `avisarDeCambio` cuando el estado lo merece
(`DELIVERED` sigue siendo `avisarDeCambio`).

Escritura de la fila: hoy el caso de uso no abre `UnidadDeTrabajo`. La
invitación avanza en un `UPDATE` monótono; lo correcto es crear la notificación
en la misma transacción que ese avance (si el avance no se confirma, no hay
notificación; si se confirma, la hay). Un webhook repetido no avanza nada y no
crea nada — mantener esa propiedad, que es la que evita duplicados.

**Respuesta a invitación de equipo.** `AcceptInvitationUseCase` y
`DeclineInvitationUseCase` viven en `events`. Restricción: `NotificationsModule`
ya importa `EventsModule` (el guard), así que `events` **no puede** importar
`NotificationsModule` sin ciclo de módulos de Nest, y la spec 2026-10-14 dejó
escrito que `events` no importa nada de `notifications`. Opciones para el
builder (elegir una y dejarla en un docblock):

1. `events` encola un job en `notifications` (como `aviso-invitacion.ts`) y el
   **worker** crea la `Notification` y avisa. Pierde la atomicidad
   "se confirma con el cambio o no se confirma" que sí tiene el RSVP; aceptable
   si se documenta (un fallo de Redis pierde el aviso, no la membresía).
2. Extraer `NOTIFICATION_PORT` a un módulo sin dependencias que importen ambos.
3. `forwardRef`. Desaconsejado.

**[decisión de diseño]** Prefiero 2 si es barato (mantiene la notificación en
la transacción del cambio); si no, 1. Destinatario: **sólo el dueño**
(`Event.ownerId`), por la regla de §3 — la vista Members exige `OWNER`. Quien
acepta o rechaza nunca es el dueño, así que no hay que excluir a nadie.
`crearParaMiembros` hoy crea para todos los ACTIVE: hará falta un método nuevo
(p. ej. `crearParaDueno(eventId, tipo, payload)`) con su doble y su paridad.

### 4.3 Lo que no cambia

- Ruta por evento `GET /events/:id/notifications`: se queda (otros clientes,
  tests e2e).
- `notification.created` sigue llevando `{ eventId, type }` sin `id` (ver el
  `DESIGN-GAP` en `broadcast-notice.use-case.ts`): el cliente vuelve a pedir
  `/me/notifications`. No hace falta cambiar el contrato.

## 5. Frontend

Repo `wedding-planner-frontend`. Piezas existentes en las que se apoya:
`src/lib/realtime.ts` (`subscribe`, `onReconnect`), `AppLayout` (monta la
`AppNavbar` única, el `<Toaster />` y ya se suscribe a
`member-invitation.changed`), `invitations-store`/`events-store` (patrón de
store de zustand atado a la sesión), `components/ui/dropdown-menu` (Radix).

### 5.1 Dónde vive la campana

Hoy la `AppNavbar` es sólo un hueco para el portal de `<PageHeader>` y se
**oculta** cuando la vista no pinta nada. La campana necesita un sitio fijo
que no dependa de la vista: añadir a la `AppNavbar` un grupo a la derecha
propio del layout (fuera del slot), y ajustar la regla de ocultarse para que
la barra no desaparezca mientras haya campana. **[decisión de diseño]** La
alternativa (campana en el `Sidebar`, junto al `EventSwitcher`) se descarta
porque en móvil el sidebar está colapsado y la campana dejaría de verse.

### 5.2 Store

`notifications-store` (zustand, módulo propio, atado a la sesión como
`events-store`: al cambiar de usuario se vacía):

- estado: `items`, `nextCursor`, `unreadCount`, `status`.
- `load()` / `reload()`: `GET /me/notifications`; `loadMore()` con cursor.
- `markRead(item)`: `POST /events/:eventId/notifications/:id/read`,
  optimista (baja el contador y pone `readAt`); si falla, revierte y toast.
- `markAllRead()`: `POST /me/notifications/read-all`, optimista igual.
- Tiempo real: en `AppLayout`, `subscribe('notification.created', …)` valida
  con zod `{ eventId, type }` y llama `reload()`; `onReconnect(reload)`.
  Mismo patrón que `member-invitation.changed`.

Validar con zod cada respuesta y cada `payload` según su `type`; un `type`
desconocido o un payload que no casa se pinta con un texto genérico
("Nueva actividad en <evento>"), nunca rompe el panel.

### 5.3 Panel

- Botón icono campana con badge de no leídas (`99+` como tope); `aria-label`
  con el número ("Notificaciones, 3 sin leer").
- Desplegable: cabecera con "Marcar todas como leídas"; lista de items
  (texto según tipo · nombre del evento · tiempo relativo · punto de no leída);
  "Cargar más" si hay `nextCursor`; estado vacío; estado de error con
  reintentar.
- **[decisión de diseño]** Sin conmutador "sólo no leídas" en esta ronda
  (simplifica; la ruta ya lo soporta si se pide después).
- Textos (inglés, como el resto de la UI):
  - RSVP: "Ana López confirmed" / "Ana López declined"
  - Rebote: "Invitation to Ana López bounced" / "… was marked as spam"
  - Equipo: "Marta joined the team" / "Marta declined the invitation"

### 5.4 Clic

1. `markRead(item)` (no se espera para navegar).
2. Navegar al destino de §3 con `navigate()`; cerrar el panel.
3. **[decisión de diseño]** El destino es la sección, sin resaltar la fila
   concreta (no hay soporte de `?guest=` en `guest-list-screen` hoy). Si se
   quiere el resaltado, es una ronda aparte.

## 6. Pruebas

Backend (convenciones del repo): unitarios de los casos de uso contra fakes;
integración de los métodos nuevos del repositorio en Testcontainers; **paridad**
para cada método nuevo del puerto; e2e de `/me/notifications` (lista global,
nombre de evento, revocado deja de ver, read-all, contador = filas no leídas
visibles) y de los dos productores nuevos (rebote crea fila + socket;
aceptar/rechazar crea fila SÓLO para el dueño, ninguna para un PLANNER o un
segundo COUPLE; `DELIVERED`
no crea nada; webhook repetido no duplica). Si se toca la regla de módulos,
`npm run lint` (dependency-cruiser) tiene que seguir verde.

Frontend: tests del store (carga, optimista y reversión, reload por socket y
por reconexión, vaciado al cambiar de sesión), de la campana (contador, `99+`,
aria-label, vacío, error), del clic (marca y navega al destino correcto por
tipo) y del texto genérico para tipos desconocidos.

## 7. Orden sugerido

1. Backend `/me/notifications` + read-all (sirve ya con los RSVP existentes).
2. Frontend campana + store + tiempo real.
3. Backend productores nuevos (rebote, respuesta de equipo); el frontend sólo
   añade sus textos.

Ramas desde `develop` y PR contra `develop` en ambos repos.

## 8. Lo que queda al builder

Nombres exactos de métodos y tipos internos, la opción de §4.2 para `events`,
si el filtro ACTIVE va en SQL o vía puerto de `events` (§4.1), si hace falta el
índice nuevo, y el diseño visual fino del panel dentro de los tokens existentes.
