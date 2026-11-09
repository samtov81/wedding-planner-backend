# Moodboard — tablero de inspiración compartido

Fecha: 2026-11-09. Abarca backend y frontend. Es la primera entrega de la
serie "conectar las pantallas que siguen con `mocks.ts`" (§2).

## 1. Intención

La pantalla `src/features/moodboard/` del frontend porta
`design/stitch/shared_inspiration_mood_board/code.html` pero pinta datos de
ejemplo y no tiene ruta. Queremos que sea real: **un sitio donde la pareja y el
planner suben e indican referencias de inspiración**, y desde el que se las
enseñan a los proveedores contratados que tienen que hacerlas realidad
(florista, decorador…), conversando sobre cada foto.

Lo que el usuario fijó en la conversación:

- Pareja y planner suben fotos de inspiración; los dos editan.
- El proveedor **no sube**: sólo ve las fotos que se le comparten.
- Se comparte **foto a foto**, eligiendo uno o varios proveedores
  **contratados** del evento (no una categoría entera).
- Cada foto tiene una **lista de notas con autor donde se puede responder**,
  y es **una conversación común**: si una foto está compartida con el florista
  y con el decorador, los dos leen lo mismo y escriben en el mismo hilo.
- **Nada se borra, para mantener un historial.** Una foto descartada se
  **archiva**: sale de la rejilla y se puede recuperar.
- Las categorías de las fotos son las **categorías de proveedor existentes**
  (`VendorCategory`), no las seis del export.
- Hay **presencia real** ("en línea") en esta entrega, y "en línea" significa
  **tener la app abierta** (cualquier pantalla), no estar mirando el moodboard.
- Contenido nuevo en directo en la pantalla abierta + campana 🔔 al proveedor
  cuando se le comparte una foto y a los participantes cuando hay nota nueva.

## 2. Contexto: la serie

Orden acordado: **moodboard** → restos de timeline → facturas → planning
(vista del proveedor) → booking; `system` en cualquier hueco. El moodboard va
primero porque es autocontenido, no toca dinero y deja hecha la subida de
archivos por evento que reutilizarán las carpetas compartidas de planning.

Regla ya fijada para entregas futuras (no afecta a ésta, que no tiene dinero):
un proveedor sólo ve el dinero que se le ha reportado **pagado** a él; nunca el
presupuesto ni nada más.

## 3. Objetivos, no objetivos, anti-objetivos

**Objetivos**

- Pareja y planner (miembros `ACTIVE`, creadores o no) suben fotos con título
  y categoría, las ven todas, las archivan/recuperan y las comparten con
  proveedores contratados.
- El proveedor contratado ve sólo lo compartido con él y participa en las
  notas de esas fotos.
- Rejilla, filtro por categoría, buscador, contadores, actividad reciente y
  colaboradores con presencia, todo con datos reales.
- Tiempo real para el contenido y para la presencia; campana para los dos
  avisos de §7.
- `src/features/moodboard/mocks.ts` (y su test y los SVG de
  `src/assets/moodboard/` que queden sin uso) desaparecen.

**No objetivos (esta entrega)**

- Borrar o editar fotos o notas (decisión del usuario: historial).
- Que el proveedor suba fotos.
- Compartir por categoría o compartir con proveedores externos sin cuenta.
- Presencia "en esta pantalla" (quién está mirando el moodboard ahora).
- Reordenar fotos a mano, tableros múltiples por evento, notas con imágenes.
- Correo: los avisos son sólo dentro de la app.

**Anti-objetivos (sería un fracaso aunque funcione)**

- Que un proveedor llegue, por REST o por socket, a una foto, nota, contador,
  actividad o colaborador que no le corresponde.
- Nota: como la conversación de cada foto es común (decisión del usuario), un
  proveedor **sí** ve el nombre de otro proveedor que haya escrito en esa foto,
  y puede recibir la campana por su nota. Lo que no se le da es la **lista** de
  con quién está compartida la foto.
- Que algo desaparezca del historial: archivar no es borrar, y dejar de
  compartir no borra las notas.
- Un "en línea" que se queda encendido para siempre porque un proceso murió
  sin desconectar el socket.

## 4. Quién ve y hace qué

Permisos sobre `EventAccess` (`events/domain/event-access.ts`); "miembro" =
`kind: 'member'` (COUPLE o PLANNER, `ACTIVE`, sea o no `OWNER`); ADMIN se
comporta como miembro, como en el resto de módulos.

| Acción | Miembro | Proveedor contratado | Fuera del evento |
|---|---|---|---|
| Ver fotos activas | todas | sólo las compartidas con él | 404 |
| Ver archivadas | sí | no (para él no existen) | 404 |
| Subir foto | sí | 403 | 404 |
| Archivar / recuperar | cualquier foto | 403 | 404 |
| Compartir / dejar de compartir | sí | 403 | 404 |
| Ver con quién está compartida | sí | **no** | 404 |
| Leer notas de una foto | todas | sólo de fotos compartidas con él | 404 |
| Escribir nota | sí (foto activa) | sí (foto compartida y activa) | 404 |
| Contadores, actividad, colaboradores | sobre todo el tablero | sobre lo que ve | 404 |

- Regla de la casa: 404 para quien está fuera del evento; 403 para quien está
  dentro sin el permiso (proveedor intentando subir, archivar o compartir).
- *(Mi decisión)* Un proveedor que pide una foto **del evento** que no se le
  compartió (o archivada) recibe **404**, no 403: no se revela que existe.
- "Proveedor contratado" es lo que ya resuelve `EventAccessService`
  (`EventVendor` `BOOKED` con ficha de la plataforma). Si la contratación se
  cancela, pierde el acceso al moodboard sin tocar nada.
- *(Mi decisión)* Se comparte **por contratación** (`eventVendorId`), pero la
  visibilidad de un proveedor es la **unión** de todas sus contrataciones
  `BOOKED` en el evento. `event_vendors` no impide que una misma ficha esté
  contratada dos veces (p. ej. florista y decorador), y `EventAccess.vendor`
  sólo trae un `eventVendorId` arbitrario (`findFirst`): la consulta de
  visibilidad **no** puede apoyarse en él. El selector de "Share with Vendor"
  lista contrataciones (nombre + categoría). Sólo se puede
  compartir con `EventVendor` `BOOKED` **con `vendorProfileId`** (un externo
  no tiene usuario que lo vea) → 422 si no.
- *(Mi decisión)* Dejar de compartir quita la visibilidad al proveedor
  (también de las notas que él escribió en esa foto); las notas no se borran y
  reaparecen si se vuelve a compartir.
- *(Mi decisión)* En una foto archivada no se escriben notas ni se comparte
  (422); al recuperarla vuelve a admitirlo. Los proveedores no ven fotos
  archivadas aunque estén compartidas con ellos.

## 5. Modelo de datos (Prisma)

Tres tablas nuevas. Nombres orientativos; el builder ajusta a la convención de
`schema.prisma` y documenta todo en `docs/DATABASE.md` (incluidos los CHECK).

**`MoodboardImage`** (`moodboard_images`)

- `id`, `eventId` (→ Event, cascade), `categoryId` (→ VendorCategory,
  restrict), `title`, `storageKey` (`@unique`), `width`, `height`,
  `uploadedById` (→ User), `archivedAt?`, `archivedById?` (→ User),
  `createdAt`, `updatedAt`.
- CHECK: título no vacío y ≤ 120 caracteres; `width > 0`, `height > 0`;
  `archivedAt` y `archivedById` nulos o no nulos a la vez.
- Índices: `(eventId, archivedAt, createdAt)` o equivalente para la rejilla.
- `width`/`height` los manda el cliente (medidos del archivo antes de subir):
  es lo que el masonry usa para reservar la caja, y sustituye a
  `aspectRatio` del mock. No son seguridad: un valor falso sólo deforma la
  caja de quien lo subió.
- Sin borrado de fila desde la API. *(Mi decisión)* Tope de **500 fotos por
  evento** (activas + archivadas, porque nada se borra), validado en el caso de
  uso dentro de la transacción tras bloquear la fila del evento
  (`SELECT … FOR UPDATE`), igual que el tope de mesas. 422 al superarlo.

**`MoodboardShare`** (`moodboard_shares`)

- `imageId` (→ MoodboardImage, cascade), `eventVendorId` (→ EventVendor,
  cascade), `sharedById`, `createdAt`, `revokedAt?`. Cascade porque la
  compartición es de la contratación: quitar la contratación se la lleva,
  mientras que las notas cuelgan de la foto y sobreviven.
- UNIQUE `(imageId, eventVendorId)`: volver a compartir reaviva la fila
  (`revokedAt = null`) en vez de duplicarla — mismo criterio que
  `avisarAProveedor`. Dejar de compartir pone `revokedAt`. Así queda historial.
- Invariante de caso de uso (no expresable en CHECK): el `EventVendor` es del
  mismo evento que la imagen, está `BOOKED` y tiene `vendorProfileId`.

**`MoodboardNote`** (`moodboard_notes`)

- `id`, `imageId` (→ MoodboardImage, cascade), `authorId` (→ User),
  `body`, `createdAt`.
- CHECK: `body` sin espacios en blanco a los extremos no vacío y ≤ 2.000
  caracteres (mismo tope que los mensajes del chat).
- Sin `updatedAt`: no se editan.

Migración obligatoria (CI corre `prisma migrate diff`).

## 6. API (backend)

Módulo nuevo `src/modules/moodboard/` con las cuatro capas. Rutas bajo
`/events/:eventId/moodboard`, con `@RequireEventAccess(...)` +
`EventAccessGuard`; la distinción "foto compartida contigo o 404" es del caso
de uso, no del guard. Cuerpos validados con `validarCon` y Zod. La forma exacta
de rutas y respuestas es del builder; lo que debe existir:

1. **Preparar subida** (miembros) → `{ key, uploadUrl }`, reutilizando
   `SubidaDeImagenes.preparar` con un prefijo por evento
   (p. ej. `events/<eventId>/moodboard`). Mismas reglas: JPG/PNG/WebP ≤ 10 MB.
2. **Crear foto** (miembros) con `{ key, title, categoryId, width, height }`:
   `SubidaDeImagenes.confirmar` contra ese prefijo, `categoryId` de una
   categoría activa, tope de §5.
3. **Listar fotos** (todos, filtrado por quien pide): activas por defecto;
   archivadas sólo para miembros. Cada foto lleva URL de lectura firmada
   (`firmarLectura`), categoría, título, dimensiones, autor, fecha, nº de notas
   y —sólo para miembros— los proveedores con los que está compartida. Sin
   paginación con el tope de 500 *(mi decisión)*; filtro y búsqueda en cliente.
4. **Archivar / recuperar** (miembros).
5. **Fijar con quién se comparte** (miembros): recibe el conjunto completo de
   `eventVendorId` y calcula altas (crear o reavivar) y bajas (`revokedAt`).
6. **Listar notas** de una foto (orden cronológico) y **escribir nota**.
7. **Resumen del tablero** (todos, filtrado): contadores (fotos activas y
   notas visibles), actividad reciente (últimas ~10 entre "subió foto en
   <categoría>" y "dejó una nota en <categoría>", derivadas de las filas, sin
   tabla de actividad) y colaboradores (§8).

Límites de ritmo: el `global` basta salvo para escribir notas y preparar
subidas; el builder decide si añade limitadores con nombre (`@LimiteDeRuta`).

Tests exigidos: dominio; paridad fake/Prisma de cada puerto nuevo;
integración contra Postgres (CHECK, UNIQUE de shares y de `storageKey`, tope
con concurrencia); e2e de la matriz de §4 con **creador, pareja no creadora,
planner no creador, proveedor contratado con foto compartida, proveedor
contratado sin foto compartida y extraño**.

## 7. Tiempo real y avisos

Mismo patrón que lo existente (ruling C23): la petición persiste y **encola**;
el worker emite. El socket es latencia sobre un estado que ya se puede pedir
por REST.

**Salas — lo que hoy no existe y hay que añadir.** Hoy el frontend nunca
emite `join` (`src/lib/realtime.ts` sólo tiene `subscribe` y `onReconnect`) y
nada se emite a `event:<id>` salvo `broadcast-notice`. Por tanto:

- `realtime.ts` gana unirse/salir de la sala de un evento (y re-unirse al
  reconectar); la pantalla del moodboard se une al montarse y sale al
  desmontarse. Los proveedores entran por el mismo `join`, que ya los manda a
  `event:<id>:vendors`.
- Se reescribe el docblock de `salas.ts` y del gateway: `event:<id>` deja de
  ser "sólo datos de invitados" y `event:<id>:vendors` deja de estar vacía
  (lleva presencia, §8).
- Que los `presence.changed` sólo lleguen a quien tiene la pantalla abierta
  es correcto: "en línea" mide si la **otra** persona tiene la app abierta;
  quien **mira** el punto sólo necesita las actualizaciones mientras mira, y
  al entrar las recibe completas en el resumen.

**Contenido en directo** (foto nueva, archivada/recuperada, compartida o
retirada, nota nueva):

- a los miembros por `event:<id>` (`emitirAEvento`);
- a cada proveedor **por su sala de usuario** (`emitirAUsuario`), y sólo si
  esa foto es visible para él. **No** por `event:<id>:vendors`: esa sala es
  común a todos los proveedores y cada uno ve fotos distintas.
- Dejar de compartir emite al proveedor afectado un evento para que la quite.

**Campana** (persistida, `Notification`):

- `moodboard.image.shared` → al usuario de la ficha del proveedor, cuando una
  foto pasa a estar compartida con él (alta o reavivado).
- `moodboard.note.added` → a los **participantes** de la foto menos el autor:
  *(mi definición)* quien la subió, quienes han escrito notas en ella y los
  proveedores con los que está compartida ahora, **filtrados por quién puede
  ver la foto en ese momento** (un proveedor al que se le retiró, o un miembro
  revocado, no recibe nada aunque escribiera antes).
- Hoy `NotificationPort` sólo sabe crear para todos los miembros, para el
  dueño o el `event.vendor.booked`. Hace falta un método para una lista de
  `userId` concreta; el listado de la campana (`visiblesDe`, que hoy sólo deja
  a un no-miembro ver `event.vendor.booked`) tiene que dejar
  ver estos tipos a sus destinatarios (incluido el proveedor, que no es
  miembro), y el frontend tiene que saber pintarlos y llevar a
  `/events/:eventId/moodboard`.

## 8. Presencia

"En línea" = el usuario tiene **al menos un socket conectado** al namespace
`/realtime`, en cualquier pantalla. Se construye ahora, pensada para que la
reutilicen después mensajería u otras vistas.

- Estado en **Redis** (el gateway y el worker son procesos distintos y puede
  haber varias réplicas). Debe sobrevivir a la caída de un proceso sin dejar a
  nadie "en línea" para siempre: registro por socket con caducidad renovada
  por latido, no un contador `INCR/DECR`. Mecánica concreta del builder.
- **Ventana de gracia obligatoria** antes de marcar a alguien desconectado:
  el gateway echa cada socket cuando caduca su access token (15 min) y el
  cliente reconecta (`autenticar` en el gateway, `renovar` en `realtime.ts`).
  Sin gracia, todo el mundo parpadea offline/online cada 15 minutos y llena
  la sala de `presence.changed`. Lo mismo vale para recargar la página.
- Transiciones: cuando un usuario pasa de 0 a ≥1 sockets o de ≥1 a 0, se
  emite `presence.changed { userId, online }` a las salas de los eventos en
  los que participa (membresías `ACTIVE` y contrataciones `BOOKED`).
  *(Mi decisión)* La presencia de un **miembro** va a `event:<id>` y a
  `event:<id>:vendors`; la de un **proveedor** sólo a `event:<id>`, para que
  un proveedor no sepa cuándo está conectado otro.
- El estado inicial viaja en el resumen del tablero (`online` por
  colaborador); el cliente aplica después los `presence.changed`, y al
  reconectar (`onReconnect`) vuelve a pedir el resumen.
- **Colaboradores** que devuelve el resumen: para un miembro, los miembros
  `ACTIVE` del evento y los proveedores con ≥1 foto activa compartida; para un
  proveedor, los miembros `ACTIVE` y él mismo. Cada uno con nombre, avatar,
  rol legible (Couple / Planner / la categoría o especialidad del proveedor) y
  `online`.
- Dónde vive (módulo propio `presence` o dentro de `notifications`, que tiene
  el gateway) es del builder, respetando la regla de dependencia sin ciclos.

## 9. Frontend

- Ruta nueva `/events/:eventId/moodboard` dentro de `AppLayout`, con su
  `moodboard-route.tsx` (siguiendo el precedente de `timeline-route.tsx`, que
  ya resolvió cómo meter una pantalla con chrome propio en el layout). Entrada
  "Inspiration" en el menú del evento para miembros **y** proveedores
  contratados.
- `moodboard-api.ts` con esquemas Zod de cada respuesta; estado con zustand
  como los demás stores; suscripción a `realtime.ts` para contenido y
  presencia; subida con `src/lib/upload.ts` (ya valida tipo y tamaño).
- **Se implementa del export:** rejilla masonry, píldoras de filtro (ahora las
  categorías de proveedor + "All"), buscador (título y categoría), botón
  "Add New Inspiration" (miembros), overlay con "Add Note" (abre la
  conversación) y "Share with Vendor" (selector de proveedores contratados,
  sólo miembros), lateral con colaboradores + presencia, contadores y
  actividad reciente.
- **DESIGN-GAP a documentar:**
  - Las píldoras ya no son las 7 literales del export (Floral… Cake): son las
    categorías de proveedor de la API.
  - "Invite Collaborator": invitar miembros ya existe en Settings y sólo lo
    puede hacer el creador → *(mi decisión)* el botón lleva a Settings para el
    creador y no se pinta para nadie más.
  - Vista de "Archivadas" y acción archivar/recuperar: el export no las
    dibuja.
  - Panel de notas, selector de proveedores, formulario de subida (título,
    categoría) y estado vacío: el export no los dibuja; se montan con las
    primitivas existentes.
  - El proveedor ve la pantalla sin "Add New Inspiration" ni "Share with
    Vendor".
  - El encabezado ("Shared Inspiration" + descripción) queda como texto fijo
    del export.
- Se borran `mocks.ts`, `mocks.test.ts` y los SVG de `src/assets/moodboard/`
  que queden sin uso.
- Tests: API (parseo Zod de respuestas válidas e inválidas), estado (store,
  incluida la aplicación de eventos de tiempo real y presencia) y UI (lo que
  ve un miembro frente a un proveedor, filtro, búsqueda, notas, compartir,
  archivar, estado vacío).

## 10. Entrega

Ramas `feat/moodboard` creadas desde `develop` actualizado en los dos repos.
PR del backend contra `develop` primero; después el del frontend.

## 11. Decisiones mías a revisar

Marcadas en el texto como *(mi decisión)* / *(mi definición)*: 404 (no 403)
para fotos no compartidas; dejar de compartir oculta también las notas del
proveedor; sin notas ni compartir en fotos archivadas; tope de 500 fotos por
evento sin paginación; quiénes son "participantes" de una nota (filtrados por
quién ve la foto ahora); compartir por contratación con visibilidad unida por
proveedor; la presencia de
un proveedor no la ven otros proveedores; lista de colaboradores según quién
mira; "Invite Collaborator" lleva a Settings sólo para el creador.
