# Configuración del evento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar funcional la pantalla Event Settings contra la API, con escritura exclusiva del creador del evento.

**Architecture:** Backend: nuevo permiso `OWNER` resuelto en `EventAccessService` (membresía activa + `event.ownerId`) y exigido por `EventAccessGuard` en las 5 rutas de escritura. Frontend: capa `settings-api.ts` validada con zod, pantalla que carga evento → comprueba owner → carga vendors y categorías; formulario de General Information en un componente propio montado con `key` para reiniciarse tras guardar; modal de alta de proveedor con pestañas marketplace/externo.

**Tech Stack:** NestJS + Prisma + zod + vitest (backend); React 19 + react-router + zod + vitest + Testing Library (frontend).

**Spec:** `docs/superpowers/specs/2026-09-29-configuracion-evento-design.md`

## Global Constraints

- Ramas `feat/configuracion-evento` desde `origin/develop` en ambos repos; PR contra `develop`.
- Sin cambios de esquema Prisma ni migraciones.
- Frontend: sin `React.FC`; `*-screen.tsx` sólo ensambla (compuestos en su propio fichero); botones siempre `Button`/`IconButton` (no `<button>` crudo); respuestas de API validadas con zod.
- Textos de UI en inglés (como el resto de pantallas); comentarios en español.
- Gates: backend `npm run typecheck && npm run lint && npx vitest run src`; frontend `npm test && npm run typecheck && npm run lint`.
- Los e2e y el test de paridad del backend necesitan Docker (testcontainers); si no hay Docker se reporta, no se da por verde.

## Review Focus

- Un COUPLE invitado (no creador) abre `/events/:id/settings`: debe ver NotFound, y la API darle 403 en PATCH/publish/vendors.
- Presupuesto con coma o texto (`"12,5"`, `"abc"`): error de validación en el campo, sin petición.
- Vaciar fecha/presupuesto/venue en un evento publicado: la API responde 422 y el mensaje se ve; el formulario conserva lo tecleado.
- Quitar un proveedor con gastos asociados: la API rechaza y el proveedor sigue en la lista con el error visible.
- Búsqueda de catálogo sin resultados o con error de red: mensaje en el modal, sin romper la pestaña External.

---

## Backend

### Task 1: permiso `OWNER` en dominio, repositorio y servicio

**Files:**
- Modify: `src/modules/events/domain/event-access.ts`
- Modify: `src/modules/events/application/event.repository.ts` (firma `buscarMembresiaActiva`)
- Modify: `src/modules/events/infrastructure/prisma-event.repository.ts`
- Modify: `src/modules/events/infrastructure/event.repository.fake.ts`
- Modify: `src/modules/events/application/event-access.service.ts`
- Test: `src/modules/events/domain/event-access.test.ts` (nuevo), `src/modules/events/application/event-access.service.test.ts`, `src/modules/events/infrastructure/event.repository.paridad.test.ts`

**Interfaces — Produces:**
- `EventAccess` miembro: `{ kind: 'member'; role: EventRole; owner: boolean }`
- `PermisoDeEvento = EventRole | 'VENDOR' | 'OWNER'`
- `permisosDe(acceso: EventAccess): PermisoDeEvento[]` (sustituye a `etiquetaDe`)
- `buscarMembresiaActiva(eventId, userId): Promise<{ role: EventRole; owner: boolean } | null>`

- [ ] Test `permisosDe`: member COUPLE owner → `['COUPLE','OWNER']`; member PLANNER no owner → `['PLANNER']`; vendor → `['VENDOR']`; admin/none → `[]`.
- [ ] Tests del servicio: el creador resuelve `{kind:'member', role:'COUPLE', owner:true}`; un COUPLE/PLANNER no creador `owner:false`. Actualizar los `toEqual` existentes con `owner`.
- [ ] Paridad: `buscarMembresiaActiva` devuelve `owner` igual en Prisma y fake.
- [ ] Implementar: Prisma `select: { role: true, event: { select: { ownerId: true } } }` → `owner: fila.event.ownerId === userId`; fake busca en `this.eventos`.
- [ ] `npx vitest run src/modules/events` verde; commit `feat: permiso OWNER en el acceso a eventos`.

### Task 2: guard y rutas de escritura solo-owner

**Files:**
- Modify: `src/modules/events/interfaces/event-access.guard.ts`
- Modify: `src/modules/events/interfaces/events.controller.ts` (PATCH, publish)
- Modify: `src/modules/vendors/interfaces/event-vendors.controller.ts` (POST, PATCH, DELETE + docblock)
- Test: `src/modules/events/interfaces/event-access.guard.test.ts`, `test/e2e/event-vendors.e2e.test.ts`, `test/e2e/events-draft.e2e.test.ts`, `test/e2e/event-access.e2e.test.ts`

**Interfaces — Consumes:** `permisosDe` (Task 1).

- [ ] Guard test: ruta `@RequireEventAccess('OWNER')` deja pasar al creador; PLANNER y COUPLE no creador → `ForbiddenError`; extraño → `NotFoundError`; admin pasa. Actualizar `toEqual` de `eventAccess` con `owner: true`.
- [ ] Guard: `permisosDe(resultado).some((p) => permitidos.includes(p))`.
- [ ] Rutas: `@RequireEventAccess('OWNER')` en `editarEvento`, `publicarEvento`, `agregarVendor`, `actualizarVendor`, `eliminarVendor`. Docblocks actualizados.
- [ ] e2e: `event-access` espera `access: { kind:'member', role:'COUPLE', owner:true }`; nuevo caso "un planner activo no puede editar, publicar ni gestionar vendors: 403" en `event-access.e2e` (reusa `prepararEventoConPlannerActivo`).
- [ ] `npm run typecheck && npm run lint && npx vitest run src`; e2e si hay Docker. Commit `feat: sólo el creador edita el evento y sus proveedores`.

## Frontend

### Task 3: capa de datos `settings-api.ts` + modelo

**Files:**
- Create: `src/features/settings/settings-model.ts`, `src/features/settings/settings-api.ts`
- Test: `src/features/settings/settings-api.test.ts`

**Interfaces — Produces:**
```ts
// settings-model.ts
type EventStatus = 'DRAFT' | 'ACTIVE'
interface EventSettings {
  id: string; name: string; status: EventStatus
  weddingDate: string | null   // 'YYYY-MM-DD'
  currency: string; totalBudget: string | null
  venue: Location | null; isOwner: boolean
}
interface EventVendor {
  id: string; name: string; category: VendorCategory
  specialty: string | null; assignedBudget: string | null
}
interface CatalogVendor { id: string; businessName: string; category: VendorCategory; specialty: string | null }
interface EventChanges { weddingDate: string | null; totalBudget: string | null; venue: Location | null }
type NewEventVendor =
  | { kind: 'linked'; vendorProfileId: string; category: string; specialty?: string; assignedBudget?: string }
  | { kind: 'external'; name: string; email?: string; phone?: string; category: string; specialty?: string; assignedBudget?: string }
// settings-api.ts
getEvent(eventId): Promise<EventSettings>
updateEvent(eventId, changes: EventChanges): Promise<EventSettings>
publishEvent(eventId): Promise<EventSettings>
listEventVendors(eventId): Promise<EventVendor[]>
addEventVendor(eventId, input: NewEventVendor): Promise<EventVendor>
removeEventVendor(eventId, eventVendorId): Promise<void>
searchVendorCatalog({ category, q, cursor }): Promise<{ items: CatalogVendor[]; nextCursor: string | null }>
```
`getVendorCategories` se reutiliza de `features/vendors/vendors-api.ts`.

- [ ] Tests con `apiGet/apiPatch/apiPost/apiDelete` mockeados: rutas y payloads exactos (`venue` sin claves extra, `external*` sólo si vienen, `limit=20`), `weddingDate` ISO → `YYYY-MM-DD`, `isOwner` desde `access`, respuesta malformada → lanza.
- [ ] Implementar; commit.

### Task 4: formulario General Information + estado/publicación

**Files:**
- Modify: `src/features/settings/event-settings-schema.ts`
- Create: `src/features/settings/general-info-form.tsx`
- Test: `src/features/settings/general-info-form.test.tsx`

Contrato: `GeneralInfoForm({ formId, event, onSave(changes) => Promise<void>, errorFor, children })` rinde el `<form id>` con la tarjeta General Information, `children` (sección vendors) y el pie (switches inertes + Discard + Update). El padre lo monta con `key={event.updatedAt ?? …}` para reiniciarlo tras guardar.

Esquema: `weddingDate: '' | YYYY-MM-DD`, `totalBudget: '' | /^\d+(\.\d{1,2})?$/`. Venue fuera de zod (estado propio).

- [ ] Tests: payload con `null` para vacíos; presupuesto inválido no llama a `onSave`; error de `onSave` visible en `role=alert`; Discard deshabilitado sin cambios y restaura; símbolo de moneda.
- [ ] Implementar; commit.

### Task 5: filas, confirmación de borrado y modal de alta

**Files:**
- Modify: `src/features/settings/vendor-row.tsx` (+ test)
- Create: `src/features/settings/remove-vendor-modal.tsx`, `src/features/settings/assign-vendor-modal.tsx` (+ tests)

- [ ] `VendorRow`: `Avatar name`, specialty opcional, presupuesto en `currency` o "No budget".
- [ ] `RemoveVendorModal({ vendor, onOpenChange, onConfirm(): Promise<void>, errorFor })`.
- [ ] `AssignVendorModal({ open, category, onOpenChange, onAssign(input): Promise<void>, errorFor })`: Tabs Marketplace/External; búsqueda con debounce-free submit ("Search") + "Load more"; campos comunes especialidad/presupuesto.
- [ ] Tests: seleccionar ficha y enviar `linked`; externo sin nombre no envía; error visible; Load more concatena.
- [ ] Commit.

### Task 6: pantalla, ruta y limpieza

**Files:**
- Modify: `src/features/settings/event-settings-screen.tsx` (+ test reescrito)
- Create: `src/app/event-settings-route.tsx` (+ test)
- Modify: `src/app/router.tsx`, `src/app/router.test.tsx` si enumera rutas
- Delete: `src/features/settings/mocks.ts`, `mocks.test.ts` si nada más los importa

- [ ] Tests de pantalla: carga, 404 → NotFound, no owner → NotFound, error + retry, guardar, publicar (éxito/422), borrar con confirmación, alta desde modal actualiza la lista.
- [ ] Implementar; `npm test && npm run typecheck && npm run lint`; commit.
