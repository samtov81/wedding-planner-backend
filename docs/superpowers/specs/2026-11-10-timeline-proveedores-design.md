# Timeline — proveedores, confirmaciones, notas del planner y PDF

Fecha: 2026-11-10. Abarca backend y frontend. Es la segunda entrega de la
serie "conectar las pantallas que siguen con `mocks.ts`". El orden acordado
es moodboard (ya mergeado), timeline, facturas, planning y booking.

## 1. Intención

El cronograma del evento ya existe:

- `ScheduleItem`, con hora, lugar y estado `PENDING | IN_PROGRESS | DONE`.
- La pantalla `src/features/timeline/timeline-screen.tsx`, que porta
  `design/stitch/wedding_day_timeline/code.html`.
- Solo el planner cambia el estado: `puedeCambiarEstadoDelCronograma`, en
  `events/domain/event-access.ts`.

Lo que sigue maquetado (DESIGN-GAP "siguen maquetados" en
`timeline-screen.tsx`, datos en `src/features/timeline/mocks.ts`):

- "Notify Vendors" y "Vendors Ready 8 of 10".
- Los avatares del pie con "All vendors have received the timeline".
- Print, Share y "PDF Export".

Todo eso está maquetado porque **un ítem no sabe qué proveedores participan**.

El uso real, en palabras del usuario:

1. El planner carga cada ítem del cronograma.
2. Durante el día, mientras se van llevando a cabo los eventos, lo va marcando
   como completado.
3. Puede dejar notas con cosas que debe tener en cuenta.

Los proveedores contratados tienen que saber a qué hora y dónde les toca,
confirmar que lo recibieron y que se les recuerde justo antes.

Lo que fijó el usuario:

- **Notas del planner:** son solo para el planner. Ni la pareja ni los
  proveedores las ven. Ejemplo válido: "el DJ debe bajar el volumen al entrar
  los novios".
- **El proveedor contratado ve el día entero**, todos los ítems y sus estados,
  pero no las notas.
- **Confirmaciones:** cada proveedor confirma "recibido y de acuerdo". Tiene
  que **reconfirmar** cuando:
  - cambia la hora de un ítem en el que participa;
  - se añade un ítem en el que participa, o se le asigna a un ítem existente.
- **Recordatorio:** 15 minutos antes de cada participación suya, el proveedor
  recibe un aviso en la campana.
- **Un ítem puede tener varios proveedores** (la ceremonia: fotógrafo,
  florista, músicos).
- **PDF en esta entrega:**
  - todos los que tienen acceso al cronograma pueden descargarlo;
  - el del planner es distinto porque incluye sus notas.

## 2. Objetivos, no objetivos, anti-objetivos

**Objetivos**

- El planner asigna a cada ítem uno o varios proveedores contratados.
- El proveedor contratado ve el cronograma completo y confirma sus
  participaciones con un solo gesto.
- "Vendors Ready X of Y" y el pie del export con datos reales.
- "Notify Vendors" pide la confirmación a quien la tiene pendiente.
- Recordatorio en la campana 15 minutos antes de cada participación.
- Notas privadas del planner por ítem.
- PDF del cronograma para todos. El del planner lleva sus notas. "Print"
  abre ese mismo PDF.
- `src/features/timeline/mocks.ts` y su test desaparecen.

**No objetivos (esta entrega)**

- "Share" (queda como DESIGN-GAP).
- Tiempo real de la pantalla del cronograma. Se actualiza al recargar; solo
  los avisos de la campana llegan en vivo.
- Correo, SMS o push del sistema. Los avisos van solo a la campana.
- Recordatorios a la pareja o al planner.
- Imágenes o tipos de ítem (otro DESIGN-GAP ya documentado).

**Anti-objetivos (sería un fracaso aunque funcione)**

- Que una nota del planner llegue a la pareja o a un proveedor por cualquier
  vía: REST, PDF, JSON de otra ruta o campana.
- Un recordatorio que llega a deshora o que no llega:
  - a deshora: con la hora vieja después de un cambio, o para un ítem
    borrado, o para un proveedor ya desasignado o descontratado;
  - que no llega: el de un ítem válido.
- Que un proveedor aparezca como "listo" con una participación que nunca vio.
- Que el proveedor vea dinero. El cronograma no tiene dinero y no debe ganarlo.

## 3. Quién ve y hace qué

Permisos sobre `EventAccess` y `permisosDe`. "Planner" es un miembro `ACTIVE`
con rol `PLANNER`, sea o no creador. ADMIN se comporta como planner, como en
`puedeCambiarEstadoDelCronograma`.

| Acción | Planner | Pareja | Proveedor contratado | Fuera del evento |
|---|---|---|---|---|
| Ver ítems, estados y proveedores asignados | sí | sí | sí (todo el día) | 404 |
| Ver quién confirmó / "Vendors Ready" | sí | sí | sí *(mi decisión)* | 404 |
| Crear / editar / borrar ítems | sí | sí (como hoy) | 403 | 404 |
| Cambiar estado | sí | 403 (como hoy) | 403 | 404 |
| Asignar proveedores a un ítem | sí | 403 *(mi decisión)* | 403 | 404 |
| Notas del planner (leer y escribir) | sí | **no existen para él** | **no existen para él** | 404 |
| Confirmar sus participaciones | — | — | sí | 404 |
| "Notify Vendors" | sí | 403 *(mi decisión)* | 403 | 404 |
| Descargar PDF | con notas | sin notas | sin notas | 404 |

- Regla de la casa: 404 para quien está fuera del evento y 403 para quien está
  dentro sin el permiso.
- *(Mi decisión)* Para quien no es planner, las notas "no existen". Pedir la
  ruta de notas da **404**, no 403, y ningún JSON ni PDF suyo trae notas ni un
  contador de notas.
- Hoy el cronograma solo lo leen COUPLE y PLANNER
  (`@RequireEventAccess('COUPLE', 'PLANNER')` en
  `schedule/interfaces/schedule.controller.ts`). La lectura pasa a admitir
  también `VENDOR`.
- En el frontend, el menú hoy muestra Timeline solo a miembros
  (`app-layout.tsx`). Pasa a mostrarse también a proveedores.
- "Proveedor contratado" es lo que ya resuelve `EventAccessService`:
  `EventVendor` en `BOOKED` con ficha, en un evento `ACTIVE`.
- *(Mi decisión)* Si una contratación se cancela, sus asignaciones dejan de
  contar para "Vendors Ready" y sus recordatorios no se envían. Las filas no se
  borran: vuelven a contar si se recontrata.
- **Asignaciones:**
  - Solo se puede asignar a contrataciones `BOOKED` **con** ficha del mismo
    evento. Una externa no tiene usuario que confirme ni reciba avisos.
  - Asignar una externa da 422.
  - *(Mi decisión)* Las asignaciones van por contratación (`eventVendorId`).
    Lo que un proveedor ve y confirma es la unión de sus contrataciones
    `BOOKED`, igual que en el moodboard.

## 4. Confirmaciones

*(Mi propuesta, aceptada en la conversación.)* La confirmación vive en cada
**asignación** (ítem × contratación), no en el proveedor.

- Una asignación nueva nace **sin confirmar**. Esto cubre el ítem nuevo y la
  asignación a un ítem existente.
- Cambiar `startsAt` o `endsAt` de un ítem desconfirma **todas las
  asignaciones de ese ítem**.
- Cambiar título, descripción, lugar o estado **no** desconfirma.
- *(Mi decisión)* `endsAt` cuenta como "hora", igual que `startsAt`.
- **Aviso inmediato (decisión del usuario):** cuando un cambio de hora
  desconfirma asignaciones, cada proveedor afectado recibe al momento un aviso
  en la campana, del tipo `schedule.item.rescheduled` ("The time of <título>
  changed — please confirm again"). La payload lleva
  `{ scheduleItemId, title }`. *(Mi decisión)* No hay aviso de "te asignaron"
  al crear o asignar: para eso está "Notify Vendors".
- El proveedor confirma con **un solo botón** todas sus asignaciones
  pendientes del evento.
- *(Mi decisión)* Se confirma lo que el proveedor tenía delante. Si entre
  medias llega una desconfirmación, esa asignación queda pendiente; la
  confirmación no la pisa.
- **Un proveedor está "listo"** cuando todas sus asignaciones vigentes están
  confirmadas.
- **"Vendors Ready X of Y":**
  - Y = proveedores (usuarios) con al menos una asignación vigente;
  - X = los listos de entre ellos.
  - *(Mi decisión)* Un proveedor que solo trabaja con ítems ya `DONE` sigue
    contando.
- **Pie del export:**
  - los avatares de los proveedores con asignación (los que no caben se
    resumen con "+N");
  - con X = Y > 0, el rótulo "All vendors have received the timeline";
  - si no, "X of Y vendors confirmed";
  - con Y = 0, un texto que diga que todavía no hay proveedores asignados.
- Borrar un ítem borra sus asignaciones y sus notas (cascada).

## 5. Recordatorios (15 minutos antes)

- Por cada asignación vigente, al usuario de la ficha le llega un aviso en la
  campana a `startsAt − 15 min`.
- *(Mi decisión)* Se envía aunque la asignación no esté confirmada. El
  recordatorio sirve justo para que no se le pase.
- **Tecnología:** jobs **diferidos** de BullMQ (`QueuePort.enqueue` ya acepta
  `delayMs`). El worker **vuelve a comprobar el estado actual** antes de
  avisar, igual que el worker del moodboard. No avisa si:
  - el ítem ya no existe;
  - su `startsAt` ya no es el del job;
  - la asignación ya no está vigente;
  - la contratación ya no está `BOOKED`;
  - el evento no está `ACTIVE`.
- **Reprogramación:** al cambiar la hora, al asignar o al desasignar se encola
  el job nuevo. El viejo muere solo por la comprobación anterior. *(Decisión
  de mecánica para el builder: borrarlo también, o confiar en la
  comprobación.)*
- **jobId** *(mi decisión)*: incluye ítem, contratación y `startsAt`, así un
  cambio A→B→A no choca con un job viejo. No se borran jobs: el worker
  descarta los obsoletos al comprobar el estado y `QueuePort` no crece.
- *(Mi decisión)* Solo se avisa si el ítem sigue `PENDING`. Si el planner ya lo
  marcó en curso o hecho, el aviso sobra.
- *(Mi decisión)* **Recontratación:** cuando una contratación vuelve a
  `BOOKED`, se programan los recordatorios de sus asignaciones futuras.
  `ScheduleModule` exporta un puerto (p. ej. `RECORDATORIOS_PORT`) que el caso
  de uso de `vendors` que cambia el estado de la contratación llama tras el
  commit. El builder vigila la regla de dependencia: `vendors` consume el
  puerto público de `schedule`, sin ciclos.
- Si la hora ya está a menos de 15 minutos o ya pasó, no se programa.
- Si el job se procesa con mucho retraso (Redis caído), no se envía un
  recordatorio viejo. *(Mi decisión)* Se descarta si llega más tarde que
  `startsAt`.
- Notificación persistida (`Notification`) del tipo
  `schedule.item.reminder`, con payload `{ scheduleItemId, title, startsAt }`.
  *(Mi decisión)* El título y la hora se guardan al crear el aviso, para que la
  campana lo pinte sin pedir el ítem. Va al usuario de
  la ficha y le llega en vivo por `notification.created`.
  - `visiblesDe` (`notifications/infrastructure/prisma-notification.repository.ts`)
    tiene que dejar ver este tipo al proveedor contratado, como ya hace con
    los del moodboard.
  - El frontend lo pinta en la campana ("<título> starts in 15 minutes") y
    enlaza a `/events/:id/timeline?item=<id>`.

## 6. "Notify Vendors"

- Solo el planner.
- Crea un aviso en la campana del tipo `schedule.confirmation.requested`
  ("Please review and confirm the timeline") para cada proveedor con al menos
  una asignación vigente sin confirmar.
- Si no hay nadie pendiente, responde sin enviar nada y la pantalla lo dice.
- *(Mi decisión)* Límite de ritmo propio con `@LimiteDeRuta` (p. ej. 5 por
  hora por evento), para que no se use para bombardear avisos.
- La campana del proveedor enlaza a `/events/:id/timeline`.

## 7. Notas del planner

- *(Mi propuesta, aceptada)* Una **lista** de notas por ítem, con autor y
  fecha.
- Las escribe cualquier planner del evento. *(Mi decisión)* No se editan ni
  se borran, igual que las del moodboard y el chat. Hasta 2.000 caracteres.
- Solo existen para quien tiene rol PLANNER (o ADMIN). Ver §3: 404 para los
  demás.
- En la pantalla, *(mi decisión)* cada ítem muestra un indicador con el número
  de notas, solo al planner, y un panel o modal para leerlas y añadirlas.

## 8. PDF

- `GET /events/:eventId/schedule/pdf` → `application/pdf`, generado en el
  backend.
- El backend ya decide quién ve qué, así que el PDF del planner lleva las
  notas y el de los demás no. Mismo endpoint, mismo acceso de lectura (§3).
- Contenido:
  - nombre del evento y fecha;
  - cada ítem con hora de inicio y de fin, en la **zona horaria del evento**
    (`Event.timezone`);
  - título, lugar, descripción, estado y proveedores asignados, con su
    confirmación;
  - las notas, solo en el del planner.
- Ordenado por `startsAt`.
- **Tecnología a elección del builder, con estas condiciones:**
  - nada de navegador headless; demasiado peso para un PDF de texto;
  - debe funcionar en el proceso de la API;
  - debe tener un test que lo genere y compruebe que es un PDF válido que
    contiene, o no, el texto de una nota según el rol.
  - Candidatos: `@react-pdf/renderer` (el backend ya compila `.tsx` para React
    Email) o `pdfkit`.
- **Frontend:**
  - "PDF Export" descarga el archivo con nombre `timeline-<slug-o-fecha>.pdf`;
  - "Print" abre el mismo PDF en una pestaña nueva para imprimirlo;
  - "Share" queda como DESIGN-GAP.

## 9. Modelo de datos (Prisma)

Nombres orientativos. El builder ajusta a la convención y lo documenta todo en
`docs/DATABASE.md`, CHECK incluidos.

- **`ScheduleItemVendor`** (`schedule_item_vendors`):
  - `scheduleItemId` (→ ScheduleItem, cascade);
  - `eventVendorId` (→ EventVendor, cascade, por la misma razón que en el
    moodboard: borrar una contratación no puede dar 500);
  - `assignedById`, `createdAt`, `confirmedAt?`;
  - UNIQUE `(scheduleItemId, eventVendorId)`;
  - índice por `eventVendorId`.
  - Desasignar borra la fila. *(Mi decisión)* A diferencia del moodboard, aquí
    no hace falta historial.
- **`ScheduleItemNote`** (`schedule_item_notes`):
  - `id`, `scheduleItemId` (cascade), `authorId`, `body`, `createdAt`;
  - CHECK: cuerpo de 1 a 2.000 caracteres tras recortar.
- Migración obligatoria.

## 10. API (orientativa: la forma exacta es del builder)

Todo bajo `events/:eventId/schedule`, en el módulo `schedule`:

- La lectura del cronograma ya existe y se amplía:
  - acceso T (COUPLE, PLANNER, VENDOR);
  - cada ítem trae sus proveedores asignados (`eventVendorId`, nombre,
    categoría, `confirmed`);
  - el número de notas solo para el planner.
- Crear ítem acepta además `eventVendorIds` opcional (solo planner; la pareja
  que lo envíe recibe 403). *(Mi decisión)* Así un ítem nace con sus
  proveedores en una sola transacción.
- Fijar proveedores de un ítem (planner): el conjunto completo, con altas y
  bajas.
- **Permisos de planner:** notas, asignar y "Notify Vendors" usan un predicado
  propio en `events/domain/event-access.ts`, junto a
  `puedeCambiarEstadoDelCronograma`. ADMIN o miembro con rol PLANNER. No se
  usa `@RequireEventAccess('PLANNER')` a secas: para ADMIN, `permisosDe`
  devuelve `[]`. Consecuencia aceptada: el creador COUPLE de un evento antiguo
  no es planner y no ve notas.
- **Transacciones:** el módulo `schedule` hoy no usa `UnidadDeTrabajo`. Hay que
  cablearla en editar, crear y asignar: escrituras con `clienteDe` en el
  repositorio y el doble.
- Proveedores asignables (planner): las contrataciones `BOOKED` con ficha.
- Notas: listar y añadir (planner).
- Confirmar (proveedor): confirma sus asignaciones pendientes y devuelve el
  estado.
- Estado de confirmaciones (T): X, Y, la lista de proveedores con
  listo/pendiente y avatar, y para el proveedor que pide, sus pendientes.
- "Notify Vendors" (planner).
- PDF (T).

El cambio de hora dentro de "editar ítem" desconfirma las asignaciones y
reprograma los recordatorios **en la misma transacción** que la edición. Los
jobs se encolan después del commit.

Tests exigidos:

- dominio;
- paridad doble/Prisma de cada puerto nuevo o ampliado;
- integración contra Postgres (UNIQUE, CHECK y cascadas);
- e2e de la matriz de §3 con creador, pareja no creadora, planner no
  creador, proveedor contratado asignado, proveedor contratado no asignado y
  extraño;
- e2e del recordatorio con el retraso acortado: programa, reprograma al
  cambiar la hora, no envía tras desasignar;
- test del PDF con y sin notas.

## 11. Frontend

- Pantalla Timeline: se quitan los datos de `mocks.ts` y se conecta:
  - "Vendors Ready X of Y" con datos reales;
  - avatares y rótulo del pie (§4);
  - "Notify Vendors" (planner);
  - "PDF Export" y "Print".
- En cada ítem:
  - chips de proveedores asignados con su estado (confirmado/pendiente);
  - para el planner, un selector de proveedores y el indicador de notas con su
    panel.
- Vista de proveedor:
  - Timeline en su menú;
  - un aviso tipo banner "You have N participations to confirm" con el botón
    "Confirm";
  - sus ítems resaltados.
- `?item=<id>` resalta el ítem y hace scroll hasta él, como `?image=` en el
  moodboard.
- Campana: `schedule.item.reminder`, `schedule.confirmation.requested` y
  `schedule.item.rescheduled`. Los tres los ve el proveedor contratado
  (`visiblesDe`).
- DESIGN-GAP a documentar:
  - selector de proveedores, panel de notas y banner de confirmación, que el
    export no dibuja;
  - "Share" sin función;
  - "Edit Timeline" sigue retirado.
- Tests: API (zod), estado y UI (planner, pareja y proveedor).

## 12. Entrega

- Ramas `feat/timeline` desde `develop` actualizado en los dos repos.
  - En el backend ya está creada.
  - En el frontend también, sin checkout, porque el checkout principal está en
    uso.
- PR del backend contra `develop` primero, luego el del frontend.

## 13. Decisiones mías a revisar

Están marcadas en el texto como *(mi decisión)* o *(mi propuesta)*:

- Permisos:
  - la pareja ve las confirmaciones pero no asigna ni usa "Notify Vendors";
  - las notas dan 404 a quien no es planner.
- Confirmaciones:
  - asignaciones por contratación, con visibilidad unida por proveedor;
  - `endsAt` también desconfirma;
  - la confirmación no pisa una desconfirmación llegada entre medias;
  - un proveedor con ítems `DONE` sigue contando.
- Recordatorios:
  - se envían también sin confirmación, y se descartan si llegan tarde;
  - solo si el ítem sigue `PENDING`;
  - el jobId incluye `startsAt` y no se borran jobs;
  - se reprograman al recontratar;
  - la payload guarda el título.
- Avisos: no hay aviso de "te asignaron" (para eso está "Notify Vendors").
- Crear ítem acepta `eventVendorIds`.
- "Notify Vendors" con límite de ritmo.
- Datos: notas sin editar ni borrar; desasignar borra la fila.
- Interfaz: indicador de notas en el ítem; "Print" abre el PDF.
