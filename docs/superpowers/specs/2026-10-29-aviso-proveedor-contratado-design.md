# Aviso al proveedor cuando lo contratan

Fecha: 2026-10-29. Abarca backend y frontend. Amplía la campana de
notificaciones de la spec `2026-10-21-notificaciones-design.md` (léela antes:
este documento sólo describe lo que cambia).

## 1. Intención

Un proveedor del marketplace (fotógrafo, catering…) no se entera hoy de que lo
han contratado para una boda salvo que la pareja se lo diga por fuera. Cuando
el **dueño del evento** pasa su contratación a `BOOKED`, el proveedor debe
recibir un aviso en la campana, en tiempo real, que al hacer clic le lleve a
ese evento.

Decidido por el usuario: sólo este aviso en esta ronda; lo dispara el dueño
del evento (no "la pareja"). Aceptado en conjunto: texto, destino, que sólo
reciban los proveedores con cuenta y que el aviso desaparezca si lo cancelan.

## 2. Objetivos, no objetivos, anti-objetivos

**Objetivos**

- Nuevo tipo `event.vendor.booked`: una `Notification` para el proveedor de la
  contratación cuando ésta pasa a `BOOKED`.
- El proveedor la ve en la campana existente (`GET /me/notifications`), la
  recibe en tiempo real (`notification.created` en `user:<id>`) y puede
  marcarla como leída.
- Texto `"You were booked for {event.name}"`; clic → `/events/:id/dashboard`.

**No objetivos**

- Avisos al proveedor por ser añadido como candidato (`SHORTLISTED`), por
  cancelación (`CANCELLED`) o por retirada (borrado de la contratación).
- Mensajería pareja ↔ proveedor y avisos de preguntas (no existe; proyecto
  aparte).
- Avisos a proveedores "externos" (`externalName`/`externalEmail` sin
  `vendorProfileId`): no tienen usuario.
- Correo al proveedor.

**Anti-objetivos**

- Que el clic lleve a una página que el proveedor no puede abrir (regla de
  destinatarios, spec 2026-10-21 §3).
- Avisos duplicados: un `PATCH` que deja `BOOKED` en `BOOKED` (o que no toca
  `status`) no crea nada.
- Que la pareja o los planners reciban este aviso.
- Romper la visibilidad de los miembros (contador = lista).

## 3. Reglas

| Tipo | Lo dispara | Permiso de la vista | Destinatario | Destino del clic |
|---|---|---|---|---|
| `event.vendor.booked` | `PATCH /events/:id/vendors/:eventVendorId` con `status: 'BOOKED'` (exige `OWNER`), sólo si antes NO era `BOOKED` | `VENDOR` (`GET /events/:id` lo admite) | el `userId` de la `VendorProfile` de esa contratación; ninguno si es externa | `/events/:id/dashboard` |

Payload: `{ eventVendorId: string }`. El nombre del evento ya llega en cada
item de `/me/notifications` (`event.name`); no se copia al payload.

**Volver a contratar** (`BOOKED → CANCELLED → BOOKED`) **no crea una segunda
fila**: reaviva la de esa contratación (la que tiene el mismo
`payload.eventVendorId`), poniéndola sin leer y con `createdAt` actual, para
que suba arriba. Si se creara otra, al volver a `BOOKED` la vieja reaparecería
también (la visibilidad mira si hay contratación `BOOKED`, no cuál) y el
proveedor vería dos avisos idénticos con contador 2. **[decisión de diseño]**

Un proveedor con dos contrataciones en el mismo evento (dos categorías): ve los
avisos de las dos mientras alguna siga `BOOKED`, porque sigue teniendo acceso al
evento y el clic funciona. Aceptado.

## 4. Backend

### 4.1 Visibilidad (`NotificationRepository`, Task 1 de la spec anterior)

Hoy `visiblesDe(userId)` exige membresía ACTIVE en el evento. Pasa a: membresía
ACTIVE **o** una `EventVendor` del evento con `status = 'BOOKED'` cuya
`VendorProfile.userId` sea el usuario. Es el mismo criterio de acceso que
`EventAccessService` concede a un proveedor (`CONTRATACION_CON_ACCESO`); igual
que con los miembros, se repite como filtro de datos y lo sujetan los tests.
Consecuencia buscada: si cancelan la contratación, el aviso deja de verse y de
contar, y `read-all` no lo toca. Aplica a `listarDeUsuario`,
`contarNoLeidasDeUsuario` y `marcarTodasLeidas`, y hay que cubrirlo en la
paridad (doble + Prisma).

### 4.2 Marcar como leída

`POST /events/:eventId/notifications/:notificationId/read` exige hoy
`COUPLE`|`PLANNER`; un proveedor recibiría 403 y la campana revertiría con un
toast. Se añade `VENDOR` a ese método (el listado por evento sigue sin
`VENDOR`). El repositorio ya filtra por `userId`, así que nadie marca lo ajeno.

### 4.3 Productor

`UpdateEventVendorUseCase` (módulo `vendors`) detecta la transición a `BOOKED`
y crea la notificación **en la misma transacción** que el cambio de estado
(patrón de la spec anterior: `UnidadDeTrabajo` + `enTransaccion` en
`PrismaEventVendorRepository.actualizar`, que hoy abre su propio
`$transaction`). La transición se decide DENTRO de la transacción con una
escritura condicionada: el `status` se escribe con `WHERE status <> 'BOOKED'`
y sólo si afecta a una fila hubo transición. Así dos `PATCH` concurrentes no
crean dos avisos (Postgres serializa las dos escrituras sobre la fila y la
segunda reevalúa el `WHERE`, como ya hace `actualizarEstadoPorMessageId`).
**[decisión de diseño]**: escritura condicionada en vez de `SELECT … FOR UPDATE`;
basta para una fila y es el patrón que el repo ya usa.

El repositorio devuelve, además de la vista, si hubo transición a `BOOKED` y el
`userId` de la `VendorProfile` (o `null` si es externa), leídos en la misma
transacción. **[decisión de diseño]**: así el caso de uso no necesita otro
puerto para buscar al usuario del proveedor; amplía el puerto
`EventVendorRepository` (doble y paridad incluidos).

Crear o reavivar la fila: nuevo método del puerto `NotificationPort`,
`avisarAProveedor(eventId, userId, eventVendorId)` — crea la fila
`event.vendor.booked` o reaviva la existente de ese `eventVendorId` (§3). Con
doble y paridad. No comprueba nada del usuario destino (ficha suspendida, etc.):
quien llama ya sabe que es el proveedor de una contratación viva. Una sola fila
por aviso, así que un usuario que fuera a la vez miembro y proveedor del evento
no la cuenta dos veces.
`VendorsModule` importa `NotificationWriterModule` (no importa nada, no hay
ciclo).

Tiempo real: tras el commit se encola en `notifications` un job
`event.vendor.booked` `{ eventId, userId }`; el worker hace
`avisarAUsuario(userId, NOTIFICACION_CREADA, { eventId, type })`. Un fallo al
encolar se registra y se traga (como el resto). El contrato del job vive en
`vendors/application`, como `aviso-respuesta-miembro.ts` en `events`.
**[decisión de diseño]** El worker no vuelve a comprobar que la contratación
siga `BOOKED`: si la cancelaron entre medias, el cliente recarga la lista, no
encuentra el aviso y el contador sale de la lista, así que no miente.

Docblock con la correspondencia tipo → permiso → vista, como los demás tipos.

## 5. Frontend

- `describeNotification`: caso `event.vendor.booked`, payload validado con zod
  `{ eventVendorId }`, texto `You were booked for ${event.name}`, href
  `/events/:id/dashboard`. Payload roto → genérico (como hoy).
- Nada más: la campana, el store y el tiempo real ya sirven a cualquier usuario
  con sesión. Comprobar al construir (no cambiar si funciona) que un proveedor
  sin eventos propios ve la campana y que el evento al que lo contratan aparece
  en su selector de eventos; si no aparece, anotarlo como hueco y no arreglarlo
  en esta ronda.

## 6. Pruebas

Backend:

- Paridad: un proveedor `BOOKED` ve y cuenta su aviso; `SHORTLISTED`/
  `CANCELLED` no; `read-all` respeta lo mismo; un miembro no pierde nada.
- Unitarios del caso de uso: `SHORTLISTED → BOOKED` crea una fila para el
  `userId` del proveedor; `BOOKED → BOOKED` y cambios sin `status` no crean;
  `BOOKED → CANCELLED → BOOKED` deja UNA fila, sin leer y arriba;
  contratación externa no crea; si crear la notificación falla, el cambio de
  estado falla (y en Postgres real, el estado no cambia).
- Worker: el job avisa sólo a `user:<proveedor>`.
- E2E: el dueño contrata → el proveedor ve el aviso en `/me/notifications` con
  `event.name` y puede marcarlo (204); la pareja y un planner no lo ven; al
  cancelar la contratación, desaparece del listado y del contador.

Frontend: texto y href del nuevo tipo, y payload roto → genérico.

## 7. Lo que queda al builder

Nombres internos y la consulta exacta con la que el repositorio lee el
`userId` del proveedor dentro de la transacción.
