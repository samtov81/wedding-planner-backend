# Configuración del evento (backend + frontend)

> Diseño aprobado en conversación el 2026-09-29. Ramas `feat/configuracion-evento`
> desde `develop` en `wedding-planner-backend` y `wedding-planner-frontend`, con
> PR contra `develop`.

## 1. Alcance

Conectar con la API la pantalla ya maquetada `features/settings/event-settings-screen.tsx`
(hoy sobre `mocks.ts`) y dejarla funcional: datos generales del evento,
publicación y gestión de los proveedores asignados. **Sólo el creador del evento
(`Event.ownerId`) puede usar esta vista y las acciones de escritura que la
respaldan**, también en la API.

Decisiones del usuario:

- **Solo el owner, vista + API.** Editar el evento, publicarlo y crear, editar o
  quitar proveedores del evento pasan a ser exclusivos del creador. La lectura
  sigue abierta como hoy. Consecuencia aceptada: un PLANNER o un segundo COUPLE
  ya no pueden hacer esas escrituras por ningún medio.
- **Preferences inertes.** Los switches "Share settings with vendors" y
  "Privacy Mode" no tienen respaldo en el modelo: se muestran pero no
  persisten, con nota DESIGN-GAP. No se inventa comportamiento.
- **Assign New Vendor con modal.** Proveedor del marketplace (búsqueda en el
  catálogo) o externo (nombre, email, teléfono).
- **Status Draft/Published + botón Publish** en lugar de "Live & Syncing".
- **Miniatura con iniciales** (`Avatar name=`): ni `EventVendor` ni el catálogo
  exponen imagen.
- **Venue con `LocationPicker`**, el mismo componente del perfil de proveedor.

Fuera de alcance: "Manage Contract" (sin backend), el enlace "Find more vendors
in the marketplace" (no hay ruta de marketplace), el `href` de Dashboard/Admin
(no hay destino enrutado), un panel de administración.

## 2. Backend: permiso `OWNER`

### 2.1 Dominio (`modules/events/domain/event-access.ts`)

- `EventAccess` de miembro gana un campo: `{ kind: 'member'; role: EventRole; owner: boolean }`.
- `PermisoDeEvento` pasa a `EventRole | 'VENDOR' | 'OWNER'`.
- `etiquetaDe(acceso)` (una sola etiqueta) se sustituye por
  `permisosDe(acceso): PermisoDeEvento[]`:
  - `member` → `[role]`, más `'OWNER'` si `owner`.
  - `vendor` → `['VENDOR']`.
  - `admin` / `none` → `[]` (admin se resuelve antes en el guard, como hoy).

El owner sigue necesitando membresía `ACTIVE`: el creador nace con su
membresía COUPLE en la misma transacción (`create-event.use-case.ts`). Ser
owner no concede acceso por sí solo; sólo añade un permiso a quien ya lo tiene.

### 2.2 Resolución (`EventAccessService` + repositorio)

`EventRepository.buscarMembresiaActiva` devuelve `{ role, owner }`, donde
`owner = event.ownerId === userId`, resuelto en la misma consulta (Prisma
`select` de la relación `event.ownerId`) y en el fake en memoria. El test de
paridad del repositorio cubre el nuevo campo.

### 2.3 Guard

`EventAccessGuard` comprueba `permisosDe(resultado).some((p) => permitidos.includes(p))`
en vez de `permitidos.includes(etiquetaDe(resultado))`. Semántica sin cambios
para las rutas existentes: 404 sin acceso, 403 con acceso pero sin permiso,
admin salta la lista.

### 2.4 Rutas que pasan a `@RequireEventAccess('OWNER')`

| Ruta | Antes |
| --- | --- |
| `PATCH /events/:eventId` | COUPLE, PLANNER |
| `POST /events/:eventId/publish` | COUPLE, PLANNER |
| `POST /events/:eventId/vendors` | COUPLE, PLANNER |
| `PATCH /events/:eventId/vendors/:id` | COUPLE, PLANNER |
| `DELETE /events/:eventId/vendors/:id` | COUPLE, PLANNER |

Sin cambios: `GET /events/:eventId` (COUPLE, PLANNER, VENDOR), `GET
/events/:eventId/vendors` (COUPLE, PLANNER), invitar miembros (COUPLE) y el
resto de módulos.

### 2.5 Contrato

`GET /events/:eventId` ya devuelve `access`; para un miembro incluye ahora
`owner: boolean`. Es un campo añadido, no rompe clientes.

### 2.6 Tests backend

- Unit de `permisosDe` y del guard: owner pasa `OWNER`; COUPLE no owner y
  PLANNER reciben 403; vendor 403; sin acceso 404; admin pasa.
- `EventAccessService`: `owner` true/false.
- Paridad Prisma/fake de `buscarMembresiaActiva`.
- Los tests existentes de las 5 rutas que hoy ejercen PLANNER/COUPLE escribiendo
  se actualizan a la nueva regla (y se añade el caso 403 de un PLANNER).

## 3. Frontend

### 3.1 Ruta y guard de vista

- `/events/:eventId/settings` dentro de `RequireAuth` → `EventSettingsRoute`
  (`app/event-settings-route.tsx`), que monta `EventSettingsScreen` con
  `key={eventId}`, como `SeatingRoute`.
- La pantalla carga `GET /events/:eventId` primero. Si `access` no es
  `{ kind: 'member', owner: true }` → `NotFoundScreen` (mismo criterio de "no
  revelar" que el 404 del backend). Un admin también ve NotFound: no hay
  panel de admin en alcance.
- Siendo owner, carga en paralelo `GET /events/:eventId/vendors` y
  `GET /vendor-categories`.
- Carga, error y reintento: mismo patrón que `GuestListScreen`.
- Nav de `PageChrome`: Guest List → `/events/:id/guests`, Settings activo.
  Dashboard sigue en `#` (sin ruta por evento).

### 3.2 Capa de datos

- `features/settings/settings-api.ts`: `getEvent`, `updateEvent`,
  `publishEvent`, `listEventVendors`, `addEventVendor`, `removeEventVendor`,
  `listVendorCategories`, `searchVendorCatalog`. Respuestas validadas con zod
  al llegar, como `guests-api.ts`.
- `features/settings/settings-model.ts`: tipos de la pantalla (`EventSettings`,
  `EventVendor`, `VendorCategory`, `CatalogVendor`), sustituyen a los de `mocks.ts`.
- `mocks.ts`: deja de usarse en la pantalla; se borra si ningún otro fichero
  lo importa.

### 3.3 General Information (`PATCH /events/:eventId`)

- **Wedding Date**: `<input type="date">`; se envía `YYYY-MM-DD`; vacío → `null`.
  Se muestra con `weddingDate.slice(0, 10)` (el backend guarda la medianoche UTC
  de esa fecha).
- **Total Budget**: input numérico; prefijo con el símbolo de `event.currency`
  (`Intl.NumberFormat` `formatToParts`) en lugar del `$` fijo; vacío → `null`.
- **Venue**: `LocationPicker`, valor `Location | null`, mismo contrato que
  `vendor-details-form.tsx`.
- `event-settings-schema.ts` se reescribe: fecha y presupuesto opcionales
  (formato validado), venue fuera de zod como en `vendor-details-form`. El
  backend permite `null` en borrador; en un evento publicado rechaza dejar
  vacío un campo requerido (422) y ese mensaje se muestra en un `Banner`.
- "Save Changes" (chrome) y "Update Event Profile" (footer) son el mismo
  submit (`form="event-settings-form"`, como hoy). "Discard changes" vuelve a
  los últimos valores guardados. Tras guardar, el formulario se reinicia con la
  respuesta del PATCH.

### 3.4 Status y publicación

Indicador "Draft" / "Published" según `status`. Con `DRAFT` aparece "Publish
event" → `POST /publish`; en 422 se muestra el mensaje de la API en un
`Banner`; en éxito, el status pasa a Published.

### 3.5 Assigned Vendors

- Lista de `GET /vendors` del evento, agrupada por `category.name`. El filtro
  de categoría se deriva de los vendors presentes (decisión ya documentada).
  El buscador del chrome sigue filtrando por nombre/categoría.
- `VendorRow`: `Avatar` con iniciales del `name`; `specialty` (se omite si es
  `null`) y `assignedBudget` formateado en `event.currency`, o "No budget".
- **Quitar**: la papelera abre un `Modal` de confirmación; al confirmar,
  `DELETE`. Si la API lo rechaza (p. ej. el proveedor tiene gastos asociados,
  FK `Restrict`), se muestra su mensaje.
- **Assign New Vendor**: el `<select>` se alimenta de `GET /vendor-categories`
  (sustituye `ASSIGNABLE_CATEGORIES`). Elegir una categoría abre
  `AssignVendorModal` (`features/settings/assign-vendor-modal.tsx`) con
  `Tabs`:
  - *Marketplace*: búsqueda `GET /vendors?category=<slug>&q=` con "Load more"
    por `nextCursor`; se elige una ficha.
  - *External*: nombre (obligatorio), email y teléfono (opcionales).
  - Comunes: especialidad y presupuesto, opcionales.
  - Envío `POST /events/:id/vendors`; errores de la API dentro del modal; en
    éxito se cierra y la lista se actualiza con la respuesta.
  El `<select>` vuelve a su opción vacía al cerrar el modal.
- "Manage Contract", "Find more vendors in the marketplace" y los switches de
  Preferences siguen inertes, con DESIGN-GAP en el docblock.

### 3.6 Tests frontend (vitest, API mockeada)

- `settings-api.test.ts`: forma de cada llamada y validación de respuestas.
- `event-settings-screen.test.tsx` (reescrito): carga, error + reintento,
  NotFound para no-owner, guardar General Information (payload con `null`s),
  error 422, publicar (éxito y 422), quitar con confirmación y con error.
- `assign-vendor-modal.test.tsx`: búsqueda + paginación, alta desde
  marketplace, alta externa, validación de nombre, error de API.
- `event-settings-route.test.tsx` y `router.test.tsx`: la ruta existe bajo
  `RequireAuth`.
- Gates: `npm test`, `npm run typecheck`, `npm run lint` en los dos repos.

## 4. Orden

1. Backend: permiso `OWNER` + rutas + tests. PR contra `develop`.
2. Frontend: capa de datos, pantalla, modal, ruta, tests. PR contra `develop`.
