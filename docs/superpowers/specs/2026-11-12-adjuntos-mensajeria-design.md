# Adjuntos en la mensajería — y factura desde el chat

Fecha: 2026-11-12. Toca los dos repos (`wedding-planner-backend` y
`wedding-planner-frontend`). Sustituye al subsistema **planning** de la serie
(§2), que se retira.

## 1. Intención

El encargo era conectar la maqueta `src/features/planning/` del frontend
(porta `design/stitch/vendor_planning_tools_view`: hub por proveedor con
archivos compartidos, cronograma de servicio, calendario de pagos y notas).
Al contrastarla con lo que ya existe, el usuario concluyó que **no resuelve
nada que hoy no se pueda hacer**:

- Cronograma de servicio → la Timeline del evento: el proveedor contratado ve
  el día entero y confirma lo suyo (spec 2026-11-10).
- Calendario de pagos → Budget en modo proveedor y `/payments`, sólo PAID
  (spec 2026-11-11). La maqueta además pinta pagos `due` y un "Total
  Contract", que la regla del dinero prohíbe y que no existe en el modelo.
- Notas de colaboración → la mensajería 1:1 del evento.
- Archivos compartidos → **lo que falta**. El usuario lo quiere resolver
  **por el chat**: que se puedan enviar y descargar archivos en la
  conversación.

El chat hoy **no** tiene adjuntos (`Message` sólo tiene `body`; ambos specs
de mensajería, `2026-10-29` §no-objetivos y `2026-11-03` §no-objetivos, los
dejaron fuera). Esta entrega los añade, y añade el caso que lo motiva:

> Cuando un proveedor comparte una factura en el chat, quien gestiona el
> presupuesto la selecciona y **crea un gasto nuevo** con ella como factura,
> o la **asocia a un gasto existente**, sin salir del chat.

Lo que fijó el usuario en la conversación:

- Planning **se retira**: no hay hub de proveedor.
- Adjuntos en las conversaciones **`EVENT_DIRECT` y `EVENT_ROOM`**; en
  `PROFILE` no.
- Tipos y tamaño: **los mismos que una factura** — JPG, PNG, WebP y PDF,
  ≤ 10 MB. Así cualquier adjunto puede pasar a ser factura sin otra
  validación.
- **Un archivo por mensaje**, con texto opcional.
- Sólo "el planner" convierte un adjunto en factura (ver §4 qué significa).
- Si el gasto elegido ya tiene archivo de factura: **se pide confirmación y
  se reemplaza**.
- El archivo del chat y la factura son **independientes**: la factura es una
  copia; quitarla o reemplazarla en Budget no toca el mensaje.
- El vínculo adjunto → gasto **se ve sólo desde Budget**: el chat no marca
  qué adjuntos son ya factura (una marca en el chat le diría al proveedor que
  existe un gasto suyo pendiente).

## 2. Contexto: la serie

Orden acordado (`2026-11-09-moodboard-design.md` §2): moodboard (hecho) →
timeline (hecho) → facturas (hecho) → ~~planning~~ **adjuntos en la
mensajería** (esta entrega) → booking; `system` en cualquier hueco.

Regla fijada: un proveedor sólo ve el dinero que se le ha reportado PAGADO a
él. Esta entrega no le enseña dinero nuevo: el gasto creado desde el chat le
llega por las vías que ya existen (Budget en modo proveedor, `/payments`,
campana `expense.paid`) y sólo cuando pasa a PAID.

## 3. Lo verificado en el código (punto de partida)

- `Message` (`prisma/schema.prisma`): `id`, `conversationId`, `senderId`,
  `body`, `createdAt`. CHECK `messages_cuerpo_longitud`
  (`char_length(btrim(body)) BETWEEN 1 AND 2000`, migración
  `20261029120000_mensajeria_base`). `normalizarCuerpo`
  (`messaging/domain/conversacion.ts`) exige 1–2000.
- `ConversationKind`: `EVENT_DIRECT`, `EVENT_ROOM`, `PROFILE`. `EVENT_ROOM`
  lleva destinatarios fijados al enviar (`MessageRecipient`).
- Envío: `POST /conversations/:id/messages` (limitador `messages`, 30/min).
  Lectura: `GET /conversations/:id/messages`. Quien no participa recibe 404
  (`localizar-conversacion.ts`).
- `storage`: `SubidaDirecta` (reglas + prefijo; `preparar` → PUT a R2 →
  `confirmar`) y `SubidaDeFacturas` con `archivoDeFacturaValido`
  (`storage/domain/archivo-de-factura.ts`, JPG/PNG/WebP/PDF ≤ 10 MB). Puerto
  `ObjectStorage`: `firmarSubida`, `firmarLectura(key, descargarComo?)`,
  `inspeccionar`, `borrar` — **no tiene copiar**.
- `expenses`: el archivo de factura vive en `Expense.invoiceFile*`, bajo el
  prefijo `events/<eventId>/invoices` (`prefijoFacturas`). `POST`/`PATCH
  /events/:eventId/expenses` aceptan `invoiceFile: { key, name } | null` y
  confirman la key en R2 con ese prefijo antes de guardar. Reemplazar o quitar
  el archivo borra el objeto anterior tras el commit.
- `BUDGET_EDIT` = creador del evento (que nace `PLANNER`) y ADMIN. Un
  `PLANNER` invitado que no creó el evento **no** lo tiene.
- Hoy ni `expenses` importa `messaging` ni al revés.
- Frontend: `src/features/messaging/` (`thread.tsx`, `room-view.tsx`,
  `conversation-view.tsx`, `messages-panel.tsx`, `chat-bubble.tsx` con un
  DESIGN-GAP que menciona adjuntos); Budget en `src/features/budget/`
  (`expense-form-modal.tsx`, `invoice-file-field.tsx`,
  `invoice-file-button.tsx`).
- **Desfase**: el `CLAUDE.md` del frontend dice que moodboard y timeline no
  tienen ruta; ya la tienen.

## 4. Objetivos, no objetivos, anti-objetivos

**Objetivos**

- Enviar un mensaje con un archivo (JPG/PNG/WebP/PDF ≤ 10 MB) y texto
  opcional en `EVENT_DIRECT` y `EVENT_ROOM`.
- Ver el adjunto en la burbuja (miniatura si es imagen, nombre y tamaño si es
  PDF) y descargarlo con su nombre original.
- Quien tiene `BUDGET_EDIT` en el evento de la conversación, sobre cualquier
  adjunto que ve: **"Create expense"** y **"Attach to expense"**.
- Retirar la maqueta de planning.

**No objetivos**

- Adjuntos en `PROFILE`.
- Varios archivos por mensaje; otros tipos (Word, Excel…).
- Borrar o editar un mensaje o su adjunto (la mensajería no lo tiene).
- Galería de "archivos de la conversación".
- Marcar en el chat qué adjuntos son ya factura.
- Que el proveedor convierta nada en gasto.

**Anti-objetivos (fallaría aunque funcione)**

- Que alguien descargue un adjunto de un mensaje que no ve en el listado
  (otro proveedor del evento, un extraño, quien salió de la sala y pide un
  mensaje posterior a su salida) — por URL firmada o por id adivinado.
- Que el proveedor sepa, por cualquier vía (chat, socket, campana, error
  distinto), que su adjunto se convirtió en un gasto que no está PAID.
- Un segundo formulario de gasto, o una segunda regla de quién edita el
  presupuesto fuera de `permisosDe`/`BUDGET_EDIT`.
- Que la factura y el adjunto compartan objeto en R2: borrar uno rompería el
  otro.

## 5. Quién ve y hace qué

"Planner" para convertir en factura = **`BUDGET_EDIT`** del evento (creador y
ADMIN) *(mi decisión: la misma regla que ya gobierna el presupuesto; un
PLANNER invitado sin `BUDGET_EDIT` no convierte, igual que no puede crear
gastos en Budget)*.

| Acción | Participante de la conversación | Además con `BUDGET_EDIT` | No participante | `PROFILE` |
|---|---|---|---|---|
| Enviar mensaje con adjunto | sí | sí | 404 | 422 |
| Ver el adjunto en la lista y descargarlo | si ve el mensaje | igual | 404 | — |
| "Create expense" / "Attach to expense" | 403 | sí | 404 | — |

- "Ve el mensaje" es exactamente la regla que ya aplica
  `GET /conversations/:id/messages` (`ListMessagesUseCase`): en la sala, los
  miembros de hoy ven todo el historial, también lo anterior a su entrada, y
  quien salió ve hasta su `visibleHasta`. `MessageRecipient` sólo sirve para
  el "leído por N de M" y **no** filtra. La descarga **no** inventa otra
  regla: quien ve el mensaje en la lista puede descargar su adjunto, y la
  lista nunca enseña un adjunto que no se pueda abrir.
- *(Mi decisión)* "Create expense" y "Attach to expense" admiten **cualquier**
  gasto y cualquier proveedor del evento, sin comprobar que el gasto sea de
  quien envió el archivo. Quien tiene `BUDGET_EDIT` ya puede descargar el
  adjunto y subirlo a mano a cualquier gasto, así que restringirlo no protege
  nada y obligaría a que `PATCH /expenses` supiera de dónde viene la key. Si el
  gasto es de otro proveedor y pasa a PAID, ese proveedor verá la factura: es
  un acto deliberado de quien gestiona el presupuesto, igual que hoy.
- Convertir exige las dos cosas: `BUDGET_EDIT` en el evento **y** ver el
  mensaje. Sin acceso al evento, 404; dentro sin `BUDGET_EDIT`, 403; mensaje
  que no ve, inexistente, sin adjunto o de otro evento, 404 *(mi decisión:
  no se revela que existe)*.
- Proveedor contratado: envía y descarga en sus `EVENT_DIRECT`; no ve otras
  conversaciones (ya lo garantiza la mensajería: proveedor↔proveedor nunca).

## 6. Modelo de datos (Prisma)

*(Mi decisión)* Columnas opcionales en `Message`, no una tabla: la relación es
1:0..1 (un archivo por mensaje), mismo criterio que `Expense.invoiceFile*`.

```prisma
model Message {
  // …lo existente…
  attachmentKey   String?  @unique  // key en R2
  attachmentName  String?           // nombre original, para la descarga
  attachmentType  String?           // content-type confirmado en R2
  attachmentBytes Int?
}
```

- CHECK nuevos, en la migración:
  - `messages_adjunto_completo`: las cuatro columnas todas nulas o todas no
    nulas.
  - `messages_cuerpo_longitud` se **sustituye**: con adjunto, el cuerpo
    recortado tiene 0–2000 caracteres; sin adjunto, 1–2000 *(mi decisión:
    `body` sigue siendo `String` no nulo y un adjunto sin texto guarda `''`;
    hacerlo nullable obligaría a tocar cada lector de `body`)*.
  - `messages_adjunto_bytes`: `attachmentBytes` nulo o `> 0`.
- Invariante de caso de uso (no expresable en CHECK): la conversación no es
  `PROFILE`.
- `docs/DATABASE.md` documenta columnas y CHECK. Migración obligatoria.

## 7. Archivos (storage)

- Reglas de subida: **las de factura** (`archivoDeFacturaValido`). *(Mi
  decisión)* Una `SubidaDeAdjuntos` sobre `SubidaDirecta` con esas reglas y su
  propio error (`INVALID_ATTACHMENT`), en vez de reutilizar
  `SubidaDeFacturas` tal cual: el código de error que ve el chat no debe
  hablar de facturas, y si un día divergen los tipos no hay que separarlas.
- Prefijo: `events/<eventId>/messages/<conversationId>`.
- Flujo: `preparar` (firma PUT) → PUT del cliente → el envío del mensaje
  trae `attachment: { key, name }` y el caso de uso `confirma` en R2 antes de
  guardar (como facturas).
- Descarga: URL prefirmada de vida corta con `Content-Disposition:
  attachment; filename="<attachmentName>"` (lo que ya hace `firmarLectura`
  con `descargarComo`). Para imágenes, la miniatura de la burbuja usa la
  misma URL *(decisión del builder si prefiere una variante `inline`)*.
- **Copiar**: el puerto `ObjectStorage` gana `copiar(origen, destino)`
  (`CopyObjectCommand` en R2; en el fake, copia en memoria). Se usa al
  convertir en factura (§8).
- Sin R2: 503 `STORAGE_UNAVAILABLE`, como hoy.
- Objetos huérfanos (preparados y nunca enviados, o copiados a factura y
  nunca guardados en un gasto): mismo tratamiento que hoy en avatar, moodboard
  y facturas — ninguno. Fuera de alcance.

## 8. API (backend)

**Mensajería** (`src/modules/messaging/`)

| Método y ruta | Exige | Qué hace |
|---|---|---|
| `POST /conversations/:id/attachment-upload-url` | participar; no `PROFILE` (422) | `{ contentType, bytes }` → `{ key, uploadUrl }` |
| `POST /conversations/:id/messages` | como hoy | acepta además `attachment?: { key, name }`; `body` pasa a opcional si hay adjunto |
| `GET /conversations/:id/messages/:messageId/attachment` | ver el mensaje | `{ url }` prefirmada |

- El JSON de un mensaje (listado, respuesta del envío y `message.created`
  por socket) añade `attachment: { name, contentType, bytes } | null`. Nunca
  la key ni la URL.
- `name`: 1–200 caracteres, sin `/` ni `\` *(mi decisión)*; se guarda tal
  cual (la descarga ya escapa el nombre, commit `67231f8`).
- La subida usa un limitador con nombre propio (`@LimiteDeRuta`) *(cifra del
  builder; orientativo 20/min por usuario)*.
- `MessagingModule` exporta un **puerto público** para que `expenses` lea un
  adjunto sin tocar su `infrastructure/`: `buscarAdjuntoVisible(userId,
  messageId)` → `{ eventId, conversationId, senderId, key, name,
  contentType, bytes } | null`, con la regla de visibilidad de §5. Con su
  `*.fake.ts` y su caso en el test de paridad del repositorio.

**Presupuesto** (`src/modules/expenses/`)

| Método y ruta | Exige | Qué hace |
|---|---|---|
| `POST /events/:eventId/expenses/invoice-from-message` | `BUDGET_EDIT` | `{ messageId }` → `{ key, name, suggestedEventVendorId }` |

- Busca el adjunto con el puerto de mensajería (404 si no lo ve o es de otro
  evento), lo **copia** a `events/<eventId>/invoices/<uuid>.<ext>` y devuelve
  esa key. El cliente la manda después en el `POST`/`PATCH` de gastos que ya
  existen, como `invoiceFile: { key, name }`: **no hay ruta nueva de crear ni
  de editar gasto**, y la confirmación en R2, el reemplazo con borrado del
  archivo anterior y los CHECK son los de facturas.
- `suggestedEventVendorId`: si quien envió el mensaje es el dueño de la ficha
  de **exactamente una** contratación `BOOKED` del evento, su id; si no,
  `null` *(mi decisión: con dos contrataciones del mismo proveedor no se
  adivina)*. El formulario lo usa para preseleccionar el proveedor.
- Dependencia `expenses → messaging` (puerto público). `messaging` no importa
  `expenses`: sin ciclo.

## 9. Tiempo real y avisos

- Un mensaje con adjunto es un mensaje: `message.created`, no leídos y 💬
  como hoy. **Sin campana.**
- Convertir en factura **no avisa a nadie** y no emite nada a la
  conversación. Lo que ya emite `expenses` al crear o editar un gasto
  (`expense.changed` a quien ve el presupuesto; `expense.paid` /
  `vendor-payment.changed` al proveedor sólo al pasar a PAID) sigue igual.

## 10. Frontend

**Retirar planning.** Borrar `src/features/planning/` entero (pantalla,
`shared-file-folder`, `service-timeline-item`, `payment-schedule-item`,
`planning-icons`, `mocks.ts` y todos sus tests); comprobar que nada más lo
importa. Actualizar el `CLAUDE.md` del frontend (lista de pantallas sin ruta:
planning ya no existe; moodboard y timeline ya tienen ruta). El `.md` está en
`.gitignore`: el cambio es local.

**Adjuntos** (`src/features/messaging/`)

- Compositor (en `thread.tsx` y `room-view.tsx`, y por tanto en el panel 💬):
  botón de adjuntar (`IconButton` con icono de `messaging-icons.tsx`) que abre
  el selector de archivos con `accept` de los cuatro tipos; vista previa del
  archivo elegido (nombre, tamaño, quitar) sobre la caja; validación local de
  tipo y tamaño (espejo, el servidor es la verdad); "Send" habilitado con
  texto **o** adjunto. Subida: `attachment-upload-url` → PUT → envío. Estado
  de subida y error visibles; si falla, se conserva el texto y el archivo. No
  se ofrece en `PROFILE` (`profile-view.tsx`).
- Burbuja: compuesto nuevo `message-attachment.tsx` dentro de `ChatBubble` —
  imagen: miniatura con tamaño acotado; PDF: icono, nombre y tamaño. Clic →
  pide la URL y descarga. Actualizar el DESIGN-GAP de `chat-bubble.tsx`.
- `messaging-api.ts` y `messaging-model.ts`: esquemas zod con `attachment`.

**Factura desde el chat** (sólo si el usuario tiene `budgetAccess === 'edit'`
en el evento de la conversación)

- Menú de acciones del adjunto: "Create expense" y "Attach to expense".
- "Create expense": llama a `invoice-from-message` y abre **el mismo
  `ExpenseFormModal` de Budget** con el archivo ya puesto y, si llega,
  el proveedor preseleccionado. Guardar = el `POST` de siempre.
- "Attach to expense": diálogo con los gastos del evento (`GET
  /events/:eventId/expenses`, con la búsqueda `q` que ya existe) para elegir
  uno. Si el elegido ya tiene archivo, confirmación ("Replace invoice
  file?") antes de seguir. Después: `invoice-from-message` → `PATCH` con
  `invoiceFile`. Toast de resultado.
- `ExpenseFormModal` se reutiliza; si hay que moverlo o exportar algo de
  `features/budget/` para usarlo desde mensajería, se hace sin duplicarlo.
- Reglas del rediseño: tokens con variables CSS, tema oscuro sin `dark:`,
  iconos con `createIcon`, cero valores arbitrarios, las `*-screen.tsx` sólo
  ensamblan, DESIGN-GAP documentados (p. ej. el export de mensajería no
  dibuja el menú de acciones del adjunto).

## 11. Pruebas

**Backend**

- Dominio: cuerpo con/sin adjunto (0 vs 1 carácter mínimo), nombre del
  adjunto, `suggestedEventVendorId` (0, 1, 2 contrataciones).
- Paridad fake/Prisma: mensaje con adjunto (crear, listar, `buscarAdjuntoVisible`
  con participante, no participante, miembro que entró en la sala después
  del mensaje (lo ve), quien salió de la sala antes del mensaje (no lo ve),
  mensaje sin adjunto, otro evento).
- Integración contra Postgres: los tres CHECK y el `UNIQUE` de la key.
  `ObjectStorage.copiar` en el fake y, si la suite ya prueba el adaptador R2
  de alguna forma, del mismo modo.
- E2E, matriz de acceso:
  - creador (`BUDGET_EDIT`): envía, descarga, convierte (crear y asociar,
    con reemplazo);
  - pareja o planner no creador: envía y descarga; convertir → 403;
  - proveedor contratado: envía y descarga en su 1:1; convertir → 404/403
    según acceso; nunca recibe por socket ni campana nada del gasto PENDING
    creado desde su adjunto;
  - otro proveedor del mismo evento: descargar el adjunto ajeno → 404;
  - extraño: 404 en todo;
  - `PROFILE`: `attachment-upload-url` → 422; enviar con `attachment` → 422.
- Arquitectura: la nueva dependencia `expenses → messaging` pasa
  `modulos-no-se-tocan-las-tripas` (sólo el puerto exportado).

**Frontend**

- API (zod): mensaje con y sin `attachment`, `invoice-from-message`.
- Estado: subida (ok, error, reintento conservando texto y archivo).
- UI: compositor (habilitado con sólo adjunto, rechazo local de tipo y
  tamaño, no aparece en `PROFILE`), burbuja (imagen y PDF), menú de factura
  visible sólo con `budgetAccess === 'edit'`, confirmación de reemplazo,
  formulario prellenado.
- Que `src/features/planning/` ya no existe y nada lo importa (typecheck y
  lint lo cubren).

## 12. Entrega

- Ramas `feat/planning` desde `develop` actualizado en los dos repos, como
  pidió el usuario *(el nombre se mantiene aunque el contenido sea adjuntos;
  cambiarlo es decisión suya)*.
- PR contra `develop`, primero el del backend.
- Ejecución subagent-driven a partir del plan.

## 13. Decisiones mías a revisar

1. "Planner" = `BUDGET_EDIT` (creador + ADMIN), no cualquier `PLANNER` (§5).
2. Columnas en `Message` en vez de tabla; `body = ''` con adjunto (§6).
3. `SubidaDeAdjuntos` propia con error `INVALID_ATTACHMENT` (§7).
4. Copia en R2 (`copiar`) en vez de compartir objeto (§7) — consecuencia
   directa de "son independientes".
5. Una ruta `invoice-from-message` que copia y devuelve la key, reutilizando
   `POST`/`PATCH` de gastos en vez de rutas nuevas de crear/asociar (§8).
6. `suggestedEventVendorId` sólo con exactamente una contratación BOOKED (§8).
7. 404 (no 403) para un mensaje que no se ve al convertir (§5).
8. Nombre de rama `feat/planning` mantenido (§12).
9. Visibilidad del adjunto = la del listado de mensajes; en la sala no
   filtra por destinatarios (§5).
10. Convertir admite cualquier gasto o proveedor del evento, sin atarlo a
    quien envió el archivo (§5).
