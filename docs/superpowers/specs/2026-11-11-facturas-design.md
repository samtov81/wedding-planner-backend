# Facturas y pagos — datos de factura en los gastos de Budget

Fecha: 2026-11-11. Toca los dos repos (`wedding-planner-backend` y
`wedding-planner-frontend`). Tercer subsistema de la serie (§2).

## 1. Intención

La maqueta `src/features/invoices/` del frontend porta
`design/stitch/invoice_payments_dashboard_1` y `_2` (la misma pantalla con un
toggle Overview / By Category) con datos de `mocks.ts`, sin ruta ni backend.
Queremos que sea real, **pero no como una pantalla aparte**: la factura es la
información de facturación de un gasto que ya existe en Budget.

Lo que el usuario fijó en la conversación:

- Una "factura" son **los datos básicos de la factura de un gasto apuntado a
  mano**: número de factura, subtotal y total, el proveedor (que el gasto ya
  tiene) y, **opcionalmente, el archivo** (PDF o foto).
- **Un gasto tiene como mucho una factura.** Si un proveedor cobra en partes
  (anticipo y resto), son **dos gastos**, cada uno con su factura.
- **Sólo el planner del evento gestiona el presupuesto**: carga facturas y
  marca pagos. Se mantiene el `BUDGET_EDIT` actual (creador del evento, que
  siempre es su `PLANNER`, más ADMIN).
- El **proveedor contratado** ve sus gastos PAID **incluidos número de
  factura y archivo adjunto**.
- Facturas es **una parte de Budget**, no una ruta ni una entrada de menú
  propias. Al proveedor **le aparece Budget mostrando sólo lo suyo**.
- Del export entran: estado **Overdue**, **Upcoming Payments**, **Total Paid
  por categoría**, **búsqueda** y la card **"Need help with contracts?"**
  (sin acción, "por ahora, nada"). **"Automated Payouts" no entra.**
- Cuando un gasto de un proveedor pasa a PAID, el proveedor recibe **campana y
  actualización en tiempo real**.
- Si se **cancela la contratación** (CANCELLED) después de pagarle, el
  proveedor **sigue viendo sus pagos y facturas**, aunque ya no pertenezca al
  evento. Los encuentra en **una página propia** de pagos recibidos, fuera de
  los eventos.

## 2. Contexto: la serie

Orden acordado (`2026-11-09-moodboard-design.md` §2): moodboard (hecho) →
restos de timeline (hecho) → **facturas** → planning (vista del proveedor) →
booking; `system` en cualquier hueco.

Regla ya fijada: **un proveedor sólo ve el dinero que se le ha reportado
pagado a él**; nunca el presupuesto, ni importes pendientes, ni ningún otro
dato económico del evento. En esta entrega: la API sólo devuelve a un VENDOR
gastos con `status = PAID` y `eventVendorId` = su `EventVendor`.

## 3. Lo verificado en el código (punto de partida)

- `Expense` (`prisma/schema.prisma`): `eventId`, `eventVendorId?` xor
  `payeeName?`, `concept`, `category` (texto libre), `amount Decimal(12,2)`,
  `status PENDING|PAID`, `dueDate? @db.Date`, `paidAt?`, `notes?`,
  `createdById`. CHECK en la migración `20260924120000_…`:
  `expenses_monto_positivo` (`amount > 0`), origen exclusivo, y
  `expenses_pagado_con_fecha` (`status = PAID` ⇔ `paidAt` no nulo). Sin
  ningún modelo de factura.
- `paidAtTrasCambio` (`expenses/domain/expense.ts`) ya decide `paidAt` en el
  servidor.
- Rutas en `expenses.controller.ts`: `GET expenses` y `GET budget-summary`
  con `BUDGET_VIEW`; `POST`/`PATCH`/`DELETE expenses` con `BUDGET_EDIT`.
- `permisosDe` da a un `vendor` sólo `['VENDOR']`: hoy no ve ningún gasto.
  Sólo un `EventVendor` **BOOKED con ficha** (`vendorProfileId`) da acceso
  `vendor` (`EventAccessService`); un proveedor externo no tiene cuenta.
- `storage` sólo sabe subir **imágenes** (`SubidaDeImagenes`,
  `storage/domain/imagen.ts`: JPG/PNG/WebP ≤ 10 MB). El puerto
  `ObjectStorage` (firmar subida/lectura, inspeccionar, borrar) es genérico.
- Avisos: el moodboard usa cola propia + worker que emite por socket, y crea
  la campana dentro de la transacción (`moodboard/application/avisos-moodboard.ts`).
  Las campanas que ve un proveedor se filtran por `TIPOS_PARA_PROVEEDOR`
  (`notifications/application/notification.port.ts`).
- `Event.timezone` existe (por defecto `UTC`) y `Event.currency`.
- Frontend: `/events/:eventId/expenses` → `BudgetScreen`
  (`src/features/budget/`); el menú Budget sale si `budgetAccess !== 'none'`
  (`src/app/app-layout.tsx`); `EventAccessKind` incluye `'vendor'`. La
  maqueta `invoices/` monta su propio `Sidebar`/`AppTopbar`.
- **Discrepancias con lo que se suponía**: (a) no existe "gasto que nace del
  plan contratado": `EventVendor` no guarda paquete ni precio
  (`VendorPackage` no está ligado al evento); (b) el código **no** garantiza
  un solo `PLANNER` por evento (se puede invitar o cambiar a rol `PLANNER`,
  `events.dto.ts:45`, `members.dto.ts:10`). Ambas quedan fuera (§4).

## 4. Objetivos, no objetivos, anti-objetivos

**Objetivos**

- El planner carga en cada gasto: número de factura, subtotal y archivo
  opcional; el total es el `amount` que ya existe.
- Budget del planner gana: columnas nº factura y adjunto, estado Overdue,
  tarjeta de vencidos, Upcoming Payments, Total Paid por categoría, búsqueda
  y la card "Need help with contracts?" inerte.
- El proveedor ve en Budget sus pagos recibidos (sólo PAID suyos) y puede
  descargar el archivo.
- Campana y tiempo real al proveedor; tiempo real para quien ve el
  presupuesto.

**No objetivos (pendientes anotados)**

- **Gasto que nace al contratar un plan** (precio fijado por el paquete):
  pendiente para **booking**.
- **Impedir más de un `PLANNER` por evento**: pendiente aparte.
- "Automated Payouts" (no hay pasarela de pago): DESIGN-GAP.
- Varias facturas por gasto; facturas sin gasto.
- Que el proveedor suba su factura.

**Anti-objetivos (fallaría aunque funcione)**

- Que un VENDOR reciba, por cualquier vía (listado, resumen, archivo, socket,
  campana, error distinto), un gasto PENDING, un gasto de otro proveedor, el
  presupuesto, notas, categorías o vencimientos.
- Duplicar Budget: una segunda lista de gastos o un segundo formulario.
- Duplicar la regla de acceso fuera de `EventAccessService`/`permisosDe`.

## 5. Quién ve y hace qué

| Quién | Ve | Hace |
|---|---|---|
| Creador (`PLANNER`+`OWNER`) y ADMIN — `BUDGET_EDIT` | todo | crear/editar/borrar gastos, datos de factura, subir/quitar archivo, marcar pagado |
| Miembro con grant — `BUDGET_VIEW` | todo, incluido descargar archivos | nada |
| Proveedor cobrado (ver abajo) | sólo sus gastos PAID: concepto, total, subtotal, impuestos, nº factura, fecha de pago, archivo | nada |
| Miembro sin grant, extraño | nada | nada |

**Quién es "proveedor cobrado".** El usuario dueño de la ficha
(`vendorProfileId`) de un `EventVendor` del evento con estado **BOOKED o
CANCELLED** (decisión del usuario: CANCELLED conserva sus pagos). Un
SHORTLISTED no *(mi decisión: nunca estuvo contratado)*. La regla es una sola
y cubre tres casos:
- el proveedor BOOKED puro (acceso `vendor`);
- el **miembro que además es proveedor** BOOKED, cuyo acceso resuelve
  `member` porque `EventAccessService` da prioridad a la membresía (mismo
  problema que resolvió `GET /confirmations` en schedule, commit `6892800`);
- el proveedor **CANCELLED**, que ya no tiene acceso al evento.

Por eso las rutas del proveedor **no** pasan por `EventAccessGuard` ni por
`permisosDe` (que siguen intactos: un CANCELLED sigue recibiendo 404 en todo
lo demás). Viven bajo `/me` (§8) y filtran por esta regla, que *(mi
decisión)* resuelve el repositorio de `expenses` con el join
`expense → event_vendor → vendor_profile.userId` y `status IN (BOOKED, CANCELLED)`:
es un filtro de *qué filas* ve, no una regla de acceso al evento, así que no
duplica `EventAccessService`.

Respuestas de error: en las rutas de evento, sin acceso **404** y sin permiso
**403**, como el resto del API. En las rutas `/me`, un gasto que no cumple la
regla (ajeno, PENDING o inexistente) es **404** *(mi decisión)*: no se
revela que existe.

Un miembro que es además proveedor ve Budget según su `budgetAccess`, como
cualquier miembro, y sus pagos recibidos en la página `/payments` (§10)
*(mi decisión: el frontend no sabe que ese miembro es proveedor del evento,
y así no hace falta un tercer modo de Budget)*.

*(Mi decisión)* El proveedor **no** ve `notes` (pueden ser comentarios
internos), `category` ni `dueDate`. Sí ve `concept` y subtotal/impuestos:
es su propia factura.

## 6. Modelo de datos (Prisma)

*(Mi decisión)* Columnas nuevas en `Expense`, no una tabla `Invoice`: la
relación es 1:0..1 y una tabla aparte sólo añadiría un join y otro puerto.
Todas opcionales, así los gastos existentes siguen siendo válidos.

```prisma
model Expense {
  // …lo existente…
  invoiceNumber      String?   // nº de la factura del proveedor, tal cual
  subtotal           Decimal?  @db.Decimal(12, 2)
  invoiceFileKey     String?   // key en R2
  invoiceFileName    String?   // nombre original, para la descarga
  invoiceFileType    String?   // content-type confirmado en R2
  invoiceFileBytes   Int?
}
```

- **Impuestos = `amount − subtotal`**, derivado, no guardado: así no pueden
  descuadrar.
- CHECK (en la migración, como los existentes):
  - `expenses_subtotal_valido`: `subtotal IS NULL OR (subtotal > 0 AND subtotal <= amount)`.
  - `expenses_archivo_completo`: las cuatro columnas `invoiceFile*` son todas
    nulas o todas no nulas.
  - `expenses_numero_no_vacio`: `invoiceNumber IS NULL OR length(btrim(invoiceNumber)) > 0`.
- UNIQUE *(mi decisión)*: el mismo emisor no repite número de factura en un
  evento. Índice único parcial por expresión, en SQL de la migración:
  `(eventId, COALESCE(eventVendorId::text, lower(payeeName)), invoiceNumber) WHERE invoiceNumber IS NOT NULL`.
  Violarlo → `409 INVOICE_NUMBER_TAKEN`.
- `docs/DATABASE.md` documenta las columnas, los tres CHECK y el UNIQUE, y
  qué valida el caso de uso (p. ej. que el archivo confirmado existe en R2).
- Migración nueva (CI falla sin ella).

## 7. Archivos (storage)

`storage` pasa a aceptar documentos además de imágenes, sin duplicar
`SubidaDeImagenes`:

- *(Mi decisión)* Generalizar la subida a un conjunto de tipos permitido por
  uso: el actual de imágenes (avatar, portfolio, moodboard, sin cambios) y uno
  nuevo de **factura**: JPG, PNG, WebP y **`application/pdf`**, ≤ 10 MB. Mismo
  flujo `preparar` → PUT directo a R2 → `confirmar` (inspecciona tipo y tamaño
  reales y borra si no cumplen). El error de tipo/tamaño de factura tiene su
  propio código (`INVALID_INVOICE_FILE`).
- Prefijo de key: `events/<eventId>/invoices/`.
- Al reemplazar o quitar el archivo, o al borrar el gasto, se borra el objeto
  de R2 tras el commit (mismo criterio que `SubidaDeImagenes.borrar`: un
  fallo se registra y no tumba la operación).
- Lectura con URL prefirmada de vida corta; *(mi decisión)* con
  `Content-Disposition: attachment; filename="<invoiceFileName>"` para que el
  PDF se descargue con su nombre. Sin R2 configurado: 503
  `STORAGE_UNAVAILABLE`, como hoy.

## 8. API (backend)

Todo en `src/modules/expenses/`. Las rutas `/events/:eventId/…` usan
`@RequireEventAccess` + `EventAccessGuard`; las `/me/vendor-payments…` sólo
exigen sesión y aplican la regla de §5 en la consulta.

**Cambios en lo existente**

- `POST`/`PATCH /events/:eventId/expenses` aceptan además
  `invoiceNumber` (string 1–60, `null` para quitar), `subtotal` (monto,
  `null` para quitar) e `invoiceFile: { key, name } | null` (key devuelta por
  la subida y nombre original del archivo, que R2 no guarda; `null` para
  quitarlo). Tanto al crear como al editar *(mi decisión)*. El caso de uso confirma la key en R2 antes de
  guardar. `subtotal > amount` → 422 (también lo para el CHECK).
- La respuesta de `Expense` añade `invoiceNumber`, `subtotal`, `tax`
  (derivado), `invoiceFile: { name, contentType, bytes } | null` y
  `overdue: boolean`.
- `GET /events/:eventId/expenses` añade los filtros `q` (búsqueda por
  subcadena, insensible a mayúsculas *(mi decisión: `ILIKE`; acentos no, para
  no añadir la extensión `unaccent`)*) sobre concepto, nombre del proveedor o `payeeName`, y nº de
  factura) y `status=OVERDUE` (además de `PENDING`/`PAID`).
- `GET /events/:eventId/budget-summary` añade `overdue` (suma y número de
  vencidos) y `upcoming`: los **5** próximos PENDING no vencidos con
  `dueDate`, por fecha ascendente *(mi decisión: 5)*. `byCategory` ya trae
  `paid` por categoría: Total Paid por categoría no necesita backend.

**Rutas nuevas**

| Método y ruta | Exige | Qué hace |
|---|---|---|
| `POST /events/:eventId/expenses/invoice-upload-url` | `BUDGET_EDIT` | `{ contentType, bytes }` → `{ key, uploadUrl }` |
| `GET /events/:eventId/expenses/:expenseId/invoice-file` | `BUDGET_VIEW` | `{ url }` prefirmada |
| `GET /me/vendor-payments?eventId=` | sesión | gastos PAID del usuario como "proveedor cobrado" (§5), proyección reducida, agrupados por evento: `{ eventId, eventName, currency, totalReceived, payments[] }[]`. Con `eventId`, sólo ese evento (lo usa el Budget del proveedor) |
| `GET /me/vendor-payments/:expenseId/invoice-file` | sesión | `{ url }` prefirmada; 404 si el gasto no cumple la regla de §5 |

*(Mi decisión)* El proveedor tiene **rutas y DTO propios** en vez de que
`GET expenses` cambie de forma según quién pregunta: la proyección reducida
es un tipo distinto, así que un campo nuevo de `Expense` no puede filtrarse al
proveedor por olvido. El puerto añade `listarPagosRecibidos(userId, eventId | null)`
y `buscarPagoRecibido(userId, expenseId)`, con sus casos en el test de
paridad (incluidos BOOKED, CANCELLED, SHORTLISTED, PENDING y otro proveedor).
Sin paginación *(mi decisión: un proveedor tiene pocos pagos por evento)*;
orden `paidAt` desc. Limitador global, sin limitador propio.

**Overdue.** Derivado, no guardado: `status = PENDING` y `dueDate` < hoy,
donde "hoy" es la fecha actual **en `Event.timezone`** *(mi decisión)*. Se
calcula en el dominio (`estaVencido(gasto, hoyEnZona)`) y el filtro
`OVERDUE` lo replica en la consulta; la paridad prueba que coinciden.

## 9. Tiempo real y avisos

Mismo patrón que el moodboard (`avisos-moodboard.ts`): **cola propia**
`expenses`, job encolado **después del commit**, un fallo de Redis se
registra y no se propaga; el worker de `expenses/interfaces/` emite por socket.

- **Campana al proveedor**: tipo nuevo `expense.paid`, creada **dentro de la
  transacción** cuando un gasto con `eventVendorId` de un proveedor **BOOKED con
  ficha** *(mi decisión: sólo BOOKED, el mismo criterio que da acceso y que
  filtra las campanas de proveedor; a un SHORTLISTED no se le avisa)*
  **pasa a PAID** (al crearlo ya PAID o al cambiarlo). Se añade a
  `TIPOS_PARA_PROVEEDOR`. Payload sin importes *(mi decisión: "Se ha
  registrado un pago de <evento>: <concepto>")*; el importe se ve al abrir
  Budget. *(Mi decisión)* No hay campana al editar, volver a PENDING o
  borrar un gasto ya pagado.
- **Socket**:
  - `expense.changed { eventId }` a la sala `user:<id>` de cada usuario con
    `BUDGET_VIEW` en ese momento: el creador y los miembros con grant (a los
    ADMIN que no son miembros no se les emite).
    *(Mi decisión)* No se usa la sala `event:<id>` porque incluye a miembros
    sin grant. El cliente recarga lista y resumen.
  - `vendor-payment.changed { eventId }` a `user:<id>` del proveedor cobrado
    (§5, incluido un CANCELLED, que sigue viendo sus pagos) cuando
    cambia algo que él ve o deja de ver: pasa a PAID, se edita estando PAID,
    vuelve a PENDING, se borra estando PAID, o cambia de proveedor. El
    evento **no lleva datos**: el cliente vuelve a pedir `/me/vendor-payments`,
    que aplica la regla. Quién recibe lo decide el caso de uso (antes y
    después del cambio) y va en el job.
- Proveedores externos y gastos a `payeeName`: ni campana ni socket.

## 10. Frontend

- **Ruta**: sigue siendo `/events/:eventId/expenses`. El menú Budget se
  muestra si `budgetAccess !== 'none'` **o** `access === 'vendor'`.
- **`BudgetScreen` en modo planner/grant** integra lo de la maqueta:
  - `ExpensesTable`/`ExpenseRow`: columnas nº factura y adjunto (botón que
    pide `invoice-file` y abre la URL); badge Overdue.
  - Tarjeta de vencidos junto a las de resumen; panel Upcoming Payments
    (reutiliza `upcoming-payment-item.tsx` de `invoices/`);
    `CategoryBreakdown` muestra pagado por categoría (toggle Overview / By
    Category de la maqueta, uno solo, como ya decidió su docblock).
  - Búsqueda (`SearchField`) que manda `q` al listado; filtro de estado con
    Overdue.
  - `ExpenseFormModal` (sólo con `budgetAccess = edit`; al crear y al
    editar): nº factura, subtotal (impuestos
    mostrados, derivados) y archivo opcional (subir / reemplazar / quitar).
  - Card "Need help with contracts?" con el botón **deshabilitado**
    ("Coming soon") y comentario DESIGN-GAP *(mi decisión)*.
  - "Automated Payouts": no se pinta; DESIGN-GAP en el docblock.
  - "View all N invoices": no se pinta (Budget ya lista todo con filtros).
- **`BudgetScreen` en modo proveedor** (acceso `vendor`): sólo lectura; tarjeta "Total
  received" y tabla de pagos recibidos (concepto, nº factura, subtotal,
  impuestos, total, fecha de pago, archivo), con `GET /me/vendor-payments?eventId=`.
  Sin botones de edición, resumen, categorías, vencidos ni búsqueda.
- **Página propia `/payments`** ("Payments received"), fuera de los eventos:
  los pagos recibidos de todos los eventos, agrupados por evento con su
  total y su moneda (no se suman monedas distintas), incluidos los de
  contrataciones CANCELLED. Usa **los mismos componentes** de tabla y tarjeta
  que el modo proveedor de Budget (no hay una segunda tabla). Entrada
  "Payments" en el menú global (el que se ve sin evento, junto a Dashboard,
  Messages y Profile) *(mi decisión: sólo si el usuario tiene ficha de
  proveedor; el frontend lo sabe por el endpoint de su ficha que ya existe,
  a verificar en el plan)*.
- **Tiempo real**: suscripción en `src/lib/realtime.ts` a `expense.changed`
  / `vendor-payment.changed` que recarga los datos; el tipo de campana
  `expense.paid` se añade a `notifications-model.ts` con enlace a `/payments`
  *(mi decisión: siempre funciona, también si luego se cancela la
  contratación)*.
- **Maqueta**: se pasa a `AppLayout` + `AppNavbar` (sin `Sidebar`/
  `AppTopbar` propios). Las piezas que se reutilicen se mueven a
  `src/features/budget/`; `invoice-dashboard-screen`, `mocks.ts`,
  `mocks.test.ts` y todo lo que quede sin uso de `invoices/` se **borra**.
  Las tres listas de categorías incoherentes desaparecen con el mock: las
  categorías son las de los gastos reales.
- Reglas del rediseño: tokens con variables CSS, tema oscuro sin `dark:`,
  iconos con `createIcon` en `budget-icons.tsx`, cero valores arbitrarios,
  `budget-screen.tsx` sólo ensambla (extraer lo que crezca).

## 11. Pruebas

**Backend**

- Dominio: `estaVencido` (bordes: hoy, ayer, zona horaria), impuestos
  derivados, subtotal ≤ total, transición a PAID que dispara aviso.
- Unitarios de casos de uso contra los fakes (`ObjectStorage` fake incluido):
  confirmar archivo, reemplazo y borrado del objeto anterior, rechazo de
  tipo/tamaño, quién recibe campana y socket.
- Paridad fake/Prisma de cada método nuevo o cambiado del puerto
  (`listarPagosRecibidos`, `buscarPagoRecibido`, filtro `q`, filtro `OVERDUE`, `upcoming`,
  `overdue` del resumen, campos de factura).
- Integración contra Postgres: los tres CHECK nuevos y el UNIQUE (incluido
  que dos `payeeName` que sólo difieren en mayúsculas chocan, y que sin
  número no chocan).
- E2E de la matriz de acceso, para listado, resumen, `/me/vendor-payments`,
  los dos `invoice-file`, `invoice-upload-url` y escritura: creador; miembro
  con grant; miembro sin grant; proveedor contratado (ve **sólo** lo PAID
  suyo, **nada** de otro proveedor, ningún PENDING, y 404 en el archivo
  ajeno); miembro que además es proveedor; proveedor **CANCELLED** (sigue
  viendo sus pagos y archivos, y recibe 404 en el resto del evento);
  proveedor SHORTLISTED (no ve nada); extraño (404). Más el socket y la
  campana al proveedor.
- Arquitectura: `expenses` consume `storage` y `notifications` sólo por sus
  puertos públicos.

**Frontend**

- API: esquemas zod de `expenses-api.ts` (campos nuevos) y de
  `/me/vendor-payments`.
- Estado: `use-expense-list` con `q` y `OVERDUE`; recarga por socket.
- UI: fila con factura/adjunto/Overdue, modal con archivo, Upcoming
  Payments, vista de proveedor (no pinta nada económico ajeno), menú Budget
  para `vendor`, card de contratos deshabilitada.

## 12. Entrega

Ramas `feat/facturas` desde `develop` actualizado en los dos repos (hoy
el `develop` local va por detrás de `origin/develop` en ambos). PR del
backend contra `develop` primero; después el del frontend.

## 13. Decisiones mías a revisar

Marcadas en el texto: columnas en `Expense` en vez de tabla `Invoice`;
impuestos derivados; UNIQUE del nº de factura por emisor y evento; 404 al
proveedor en archivos ajenos; el proveedor no ve notas, categoría ni
vencimiento; PDF + imágenes ≤ 10 MB; descarga con nombre original; ruta y DTO
propios para el proveedor, bajo `/me` y sin paginación; SHORTLISTED no
cuenta como proveedor cobrado; la regla de filas en el repositorio de
`expenses`; entrada "Payments" sólo con ficha de proveedor y campana que
enlaza a `/payments`; el miembro-proveedor ve sus pagos en `/payments`, no en Budget; carga de factura al
crear y al editar; "hoy" en la zona del evento; 5 próximos pagos;
búsqueda `ILIKE` sin `unaccent`; campana sólo al pasar a PAID y sin importe;
socket del presupuesto por `user:<id>` de quien tiene acceso; botón de
contratos deshabilitado.
