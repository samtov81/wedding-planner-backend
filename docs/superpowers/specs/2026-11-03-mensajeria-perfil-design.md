# Mensajería — parte 3: contacto desde el perfil del proveedor

Fecha: 2026-11-03. Abarca backend y frontend. Continúa
`2026-10-29-mensajeria-base-design.md` (parte 1, cuyo §2 fija las reglas
comunes) y `2026-11-02-mensajeria-sala-design.md` (parte 2). Las reglas de abajo
salen de la conversación con el usuario; lo marcado **[decisión de diseño]** es
decisión mía y el usuario puede revisarlo.

## 1. Intención

Hoy dos personas sólo se escriben si comparten un evento. Quien busca proveedor
(una pareja antes de contratarlo, un planner, otro proveedor que quiere
colaborar) no tiene forma de preguntarle nada sin salir de la app. La parte 3
abre una puerta, y sólo una: el botón "Message" de la ficha pública del
proveedor. Como el desconocido no ha sido invitado, la primera vez el proveedor
acepta o rechaza; el rechazo es la única defensa (no hay bloquear ni
denunciar).

Lo que no cambia respecto de las partes 1 y 2: sólo texto, 1–2.000 caracteres,
sin editar ni borrar; origen, fecha y hora siempre claros, agrupados por día;
avisos sólo dentro de la app (contador y tiempo real), sin correo, sin sonido y
sin entradas en la campana 🔔; historial paginado hacia atrás (50 por página).

## 2. Objetivos, no objetivos, anti-objetivos

**Objetivos**

- Botón "Message" en `/vendors/:vendorId` que, con sesión, envía una solicitud
  con un primer mensaje; sin sesión, lleva al login y vuelve a la ficha.
- El proveedor ve las solicitudes en la sección "Requests" de la bandeja, con
  su contador, y acepta o rechaza.
- Aceptada, es un hilo 1:1 normal (burbujas, ✓/✓✓, separadores de día, tiempo
  real) en la sección "Others" de la bandeja.

**No objetivos**: bloquear, denunciar, deshacer un rechazo, adjuntos, avisos por
correo o en la campana, el panel flotante 💬 (parte 4), contactar con alguien
que no sea proveedor con ficha publicada.

**Anti-objetivos**

- Que alguien pueda inundar a un proveedor: más de un mensaje por solicitud
  pendiente, o volver a pedir antes de 24 h tras un rechazo.
- Que la ficha pública revele el usuario dueño o su email (hoy no lo hace; el
  contacto se hace por `vendorId`, nunca por `userId`).
- Que una conversación del perfil se mezcle con la del evento: son dos
  conversaciones distintas aunque las personas sean las mismas.
- Romper la bandeja de la parte 1: su zod exige `event` y `other` en cada
  elemento de `GET /me/conversations`; nada de la parte 3 va ahí.
- Un mensaje sin origen claro: en la cabecera del hilo y en la fila de la
  bandeja se lee que viene del perfil, no de un evento.

## 3. Reglas

### 3.1 Quién (decidido por el usuario)

- Puede iniciar el contacto **cualquier usuario con sesión**. El login ya exige
  email verificado (`EMAIL_NOT_VERIFIED`), así que "con sesión" implica
  verificado. Incluye a un proveedor que escribe a otro proveedor.
- Sólo a la ficha de un proveedor **publicada** (`PUBLISHED`). Una ficha
  `DRAFT`, `SUSPENDED` o inexistente es el mismo 404 que la ficha pública.
- **Nadie puede escribirse a sí mismo**: el dueño de la ficha recibe 422
  `CONTACT_SELF` **[decisión de diseño: 422 y no 403, porque es una petición
  imposible, no un permiso que falta]**; el frontend no le muestra el botón.

### 3.2 Solicitud (decidido por el usuario)

- El primer mensaje **es** la solicitud. Mientras está pendiente el solicitante
  **no** puede escribir más (403 `CONTACT_REQUEST_PENDING`).
- El proveedor ve el **mensaje completo y el nombre** del solicitante antes de
  decidir. La solicitud pendiente cuenta como no leída en su contador
  "Requests" hasta que la responde **[decisión de diseño: el contador cuenta
  solicitudes sin responder, no mensajes sin leer; abrirla no la descuenta, la
  descuenta aceptar o rechazar]**.
- El proveedor no puede escribir sin aceptar antes (403
  `CONTACT_REQUEST_PENDING`) **[decisión de diseño: aceptar es un botón
  explícito, responder no acepta implícitamente]**.
- Marcas de entregado/leído funcionan como en la parte 1 también en pendiente:
  si el proveedor abre la solicitud, el solicitante ve ✓✓ leído **[decisión
  de diseño, igual que WhatsApp]**.

### 3.3 Aceptar

- Pasa a `ACCEPTED`; ambos escriben con las reglas de la parte 1 (mismo
  limitador `messages`, 30/min). Al solicitante le llega en tiempo real.
- **Relación previa (decidido por el usuario):** si al crear la solicitud las
  dos personas ya podrían abrir hoy una conversación de evento entre sí, la
  conversación nace directamente `ACCEPTED`. "Podrían abrirla" = las reglas de
  la parte 1 §4.1 para algún evento: miembro ACTIVE ↔ miembro ACTIVE, o miembro
  ACTIVE ↔ proveedor BOOKED de evento publicado; dos proveedores del mismo
  evento **no** cuentan **[decisión de diseño]**. Se evalúa al crear y **al
  volver a pedir** tras un rechazo: si para entonces ya tienen relación, pasa
  directamente a `ACCEPTED` sin esperar las 24 h **[decisión de diseño]**.
- Sigue siendo una conversación del perfil (`PROFILE`), separada de la
  `EVENT_DIRECT` que puedan tener (decidido por el usuario).

### 3.4 Rechazar (decidido por el usuario)

- El solicitante ve claramente **"Declined"**.
- Puede volver a pedir **24 h después del rechazo**, sin tope de reintentos.
  Antes: 409 `CONTACT_REQUEST_COOLDOWN` con `retryAt` en `details`.
- El proveedor **no** puede deshacer un rechazo.
- **[decisión de diseño]** Volver a pedir reutiliza la **misma** conversación
  (una por par de personas, §3.6): pasa a `PENDING` y el nuevo primer mensaje se
  añade al historial; el proveedor ve también los mensajes anteriores.
- **[decisión de diseño]** Una conversación rechazada desaparece de la bandeja
  del proveedor (no tiene nada que hacer con ella) y reaparece en "Requests"
  si el solicitante vuelve a pedir. El solicitante la ve en "Others", en solo
  lectura, con "Declined · You can ask again from their profile on {fecha}".
  Volver a pedir se hace desde la ficha (la única puerta), no desde el hilo.

### 3.5 Ficha despublicada (decidido por el usuario)

Mientras la ficha no esté `PUBLISHED` (`DRAFT` o `SUSPENDED`, tratadas igual
**[decisión de diseño]**): nadie crea solicitudes nuevas (404); las pendientes
siguen pendientes y el proveedor puede aceptarlas o rechazarlas; las aceptadas
siguen funcionando en los dos sentidos. Una ficha nunca se borra en este
proyecto, así que "dejar de ser proveedor" es este mismo caso.

### 3.6 Identidad de la conversación

- **[decisión de diseño]** Una conversación `PROFILE` por **par de personas**
  sin orden: `pairKey = 'profile:<menor>:<mayor>'` (los userIds ordenados), que
  el UNIQUE existente garantiza aunque dos peticiones choquen.
- Guarda quién la pidió (`requesterId`) y la ficha a la que se pidió
  (`vendorProfileId`, que da el `userId` del proveedor y su `businessName`).
- Si A pidió a B y luego B entra en la ficha de A (los dos son proveedores):
  el estado de su par es el que ya existe. Si está pendiente y B es el
  destinatario, la ficha le ofrece "Open request" (lleva a "Requests"), no crea
  otra **[decisión de diseño]**.
- **[decisión de diseño]** `requesterId` y `vendorProfileId` **no cambian
  nunca**: sólo el solicitante original puede volver a pedir. Si B rechazó a A
  y luego B entra en la ficha de A, `GET /vendors/:A/contact` le devuelve
  `DECLINED_BY_ME` (sin botón: "You declined their request") y su `POST`
  responde 409 `CONTACT_DECLINED_BY_YOU`; si no, escribir sería deshacer el
  rechazo, que el usuario descartó.

### 3.7 Nombres

**[decisión de diseño]** El proveedor aparece con el `businessName` de la ficha
de la conversación (es por lo que se le conoce); el solicitante, con su
`fullName` aunque él también tenga ficha (escribió como persona). El rol que
viaja es `VENDOR` para el proveedor y `CONTACT` para el solicitante.

### 3.8 Límite de ritmo (decidido por el usuario)

Límite nuevo `contact-requests`, **10 solicitudes por hora por usuario**, sólo
en la ruta que crea la solicitud (incluidos los reintentos y las que nacen
aceptadas). Aceptar y rechazar quedan con el global; escribir en una aceptada,
con `messages`.

**Por usuario de verdad (decidido por el usuario).** Los limitadores con nombre
actuales (`messages`, `invite`, `vendor-catalog`) cuentan por IP con un
`DESIGN-GAP`: `ThrottlerGuard` es `APP_GUARD` y corre antes que `JwtAuthGuard`,
así que aún no existe `req.user`. Éste no puede heredar ese hueco. Requisitos
para el builder:

- La clave es el `userId` **autenticado**. Si se saca del token antes de
  `JwtAuthGuard`, el token tiene que estar **verificado** (firma y caducidad),
  nunca sólo decodificado: con un token fabricado alguien gastaría el cupo de
  otra persona.
- Contador en Redis (como los demás), compartido entre réplicas.
- Excederlo responde **429** con la misma forma de error que el resto de
  límites, para que el frontend lo trate igual.
- Una petición rechazada por otra causa (404, 409, 422) **sí** cuenta
  **[decisión de diseño: es lo que hace el throttler hoy y frena el sondeo]**.
- Mecanismo a elección del builder: un tracker propio para este limitador
  dentro del `ThrottlerGuard`, o un puerto de "cupo" consultado desde el caso de
  uso (ya autenticado). Si es lo segundo, sigue declarándose con algo que se
  lea en la ruta, no escondido en el caso de uso sin rastro en el controlador.
- **No** se migran `messages` ni `invite` en esta parte; su `DESIGN-GAP` queda.

## 4. Backend

### 4.1 Datos

Ampliar `Conversation` (migración con entrada en `docs/DATABASE.md`; nombres
finales del builder):

- `requesterId` (uuid, FK a `User`, nullable), `vendorProfileId` (uuid, FK a
  `VendorProfile`, nullable), `requestStatus` (enum nuevo
  `ContactRequestStatus { PENDING ACCEPTED DECLINED }`, nullable), `declinedAt`
  (nullable).
- CHECK: `kind = 'PROFILE'` ⇔ (`eventId` IS NULL y `requesterId`,
  `vendorProfileId`, `requestStatus` NOT NULL); `declinedAt` NOT NULL ⇔
  `requestStatus = 'DECLINED'`. Las de evento y sala tienen los cuatro a NULL.
- Participantes: las dos filas de `ConversationParticipant` se crean con la
  conversación, como en la parte 1.

Alternativa descartada: tabla aparte `contact_requests`. Duplicaría la
identidad del par y obligaría a unir dos tablas en cada lectura de la bandeja;
la solicitud no vive sin su conversación.

### 4.2 Rutas (todas con `JwtAuthGuard` y `validarCon`)

- `GET /vendors/:vendorId/contact` → mi estado con esa ficha, para pintar el
  botón: `{ state: 'NONE' | 'PENDING_SENT' | 'PENDING_RECEIVED' | 'ACCEPTED' |
  'DECLINED' | 'DECLINED_BY_ME' | 'SELF', conversationId: string | null, retryAt: string | null }`.
  `retryAt` sólo con `DECLINED` (puede estar en el pasado: entonces se puede
  volver a pedir). 404 si la ficha no está publicada **y** no tengo
  conversación con ella; si la tengo, devuelve su estado **[decisión de
  diseño]**. Va en el módulo `messaging` (no en el controlador público de
  `vendors`, que es sin sesión).
- `POST /vendors/:vendorId/contact` `{ body }` → crea la solicitud (o el
  reintento) con su primer mensaje. 201 con la conversación (§4.2,
  `ConversacionDePerfil`) y el mensaje. Errores: 404 ficha no publicada; 422
  `CONTACT_SELF`; 409 `CONTACT_REQUEST_PENDING` (ya hay una pendiente, de
  cualquiera de los dos); 409 `CONTACT_ALREADY_ACCEPTED` con `conversationId`;
  409 `CONTACT_REQUEST_COOLDOWN` con `retryAt`; 409 `CONTACT_DECLINED_BY_YOU`
  (§3.6). Límite `contact-requests` por usuario (§3.8).
  El reintento y su mensaje en la misma transacción, bloqueando la fila de la
  conversación.
- `POST /conversations/:id/accept` y `POST /conversations/:id/decline` → 200
  con la conversación. Sólo el proveedor y sólo en `PENDING`; si no, 404 (no
  participante o no es `PROFILE`) o 409 `CONTACT_REQUEST_NOT_PENDING`.
- `GET /me/profile-conversations` → `{ items: ConversacionDePerfil[],
  requestsPending: number, unreadTotal: number }`, donde:
  `ConversacionDePerfil = { id, kind: 'PROFILE', status, direction:
  'SENT' | 'RECEIVED', other: { userId, displayName, role: 'VENDOR' |
  'CONTACT' }, vendor: { id, businessName }, lastMessage, unreadCount,
  readOnly, retryAt, otherMarks }`. Lista las del solicitante en cualquier
  estado y las del proveedor en `PENDING` o `ACCEPTED` (§3.4). `requestsPending`
  = solicitudes recibidas pendientes; `unreadTotal` = no leídos de las
  aceptadas (las pendientes cuentan en `requestsPending`, no aquí, para no
  contarlas dos veces). Orden por `lastMessageAt` desc.
- `GET /conversations/:id/messages`, `POST .../messages`, `.../delivered`,
  `.../read`: los de siempre. `localizarConversacion` gana un tercer tipo
  (`perfil`); `readOnly` = no `ACCEPTED` (pendiente para los dos, rechazada
  para el solicitante). Enviar con `readOnly` → 403 `CONTACT_REQUEST_PENDING`
  o `CONVERSATION_READ_ONLY` según el estado. La página de mensajes lleva
  `otherMarks` como en la 1:1.

Estas conversaciones **no** salen en `GET /me/conversations` ni en
`GET /me/rooms` (§2, anti-objetivo).

### 4.3 Tiempo real

Socket `/realtime`, sala `user:<id>` (nombres en `notifications/application/salas.ts`).
Por la cola `messaging`, tras el commit, con la misma política que la parte 1
(un fallo al encolar se registra y se traga):

- `message.created` y `message.receipt` como siempre, también en `PROFILE`
  (el primer mensaje de una solicitud incluido).
- Nuevo `contact.updated` `{ conversationId }` a los dos participantes cuando
  se crea, se acepta, se rechaza o se reintenta una solicitud. Sólo el id: el
  cliente relee `GET /me/profile-conversations` (el worker no necesita
  calcular la vista de cada uno) **[decisión de diseño]**.
- El worker re-comprueba que cada destinatario sigue viendo la conversación
  (un proveedor no ve una rechazada; §3.4).

### 4.4 Pruebas

- **Dominio**: transiciones (`PENDING → ACCEPTED|DECLINED`, reintento sólo
  desde `DECLINED` y tras 24 h), quién escribe en cada estado, `pairKey` de
  perfil, autocontacto.
- **Casos de uso** contra el doble.
- **Paridad** doble/Prisma de cada método nuevo del repositorio.
- **Integración** en Postgres: UNIQUE de `pairKey` con dos solicitudes
  simultáneas (A→B y B→A), cada CHECK nuevo violado a propósito.
- **E2E** (la matriz pedida): solicitante (envía, no puede mandar un segundo,
  ve Declined, reintenta tras 24 h y no antes); proveedor (ve el mensaje y el
  nombre, contador, acepta, rechaza, no escribe sin aceptar, no deshace el
  rechazo); tercero (404 en el hilo y en accept/decline); sin sesión (401 en
  las rutas nuevas, la ficha pública sigue sin sesión); ficha despublicada
  (404 al crear, pendiente aún aceptable, aceptada sigue escribiendo);
  relación previa → nace aceptada (también al volver a pedir, sin esperar);
  autocontacto 422; quien rechazó no puede escribir desde la otra ficha (409);
  aceptación y escritura posterior en los dos sentidos; límite
  `contact-requests` por usuario (dos usuarios desde la misma IP no comparten
  cupo; el 11.º de un mismo usuario es 429; un token fabricado no gasta el cupo
  de otro); nada de esto aparece en `/me/conversations`.
- **Tiempo real**: el proveedor recibe `message.created` + `contact.updated`
  al llegar la solicitud; el solicitante, `contact.updated` al aceptar o
  rechazar; un proveedor no recibe nada de una rechazada.

El reloj de "24 h" se inyecta (como el resto de casos de uso que usan
`new Date()`, o con un puerto de reloj si el builder lo prefiere) para poder
probarlo sin esperar.

## 5. Frontend

### 5.1 Ficha pública `/vendors/:vendorId`

La ruta sigue fuera de `RequireAuth`. El botón "Message" según el estado:

- Sin sesión: "Message" → la pantalla de login (ruta `/` en `router.tsx`) con
  `state.from = /vendors/:vendorId` (`login-screen.tsx` ya vuelve a una ruta
  interna segura). El `DESIGN-GAP` de `vendor-profile-screen` que dice que no
  hay botón "Message" se actualiza (su parte de "Book Consultation" sigue). Quien se registra
  en medio pierde la vuelta (tiene que verificar el email); aceptado.
- Con sesión, de `GET /vendors/:vendorId/contact`:
  - `NONE` → "Message" abre un diálogo con un cuadro de texto (1–2.000, mismo
    contador que el hilo) y "Send request"; al enviar, pasa a "Request sent".
  - `PENDING_SENT` → "Request sent" desactivado, con el enlace al hilo.
  - `PENDING_RECEIVED` → "Open request" (lleva a la solicitud en `/messages`).
  - `ACCEPTED` → "Open conversation".
  - `DECLINED` con `retryAt` futuro → desactivado: "Declined · You can ask again
    on {fecha}"; con `retryAt` pasado → "Message" como `NONE`.
  - `DECLINED_BY_ME` → sin botón, "You declined their request".
  - `SELF` → sin botón.

### 5.2 Bandeja `/messages`

- Nueva sección **"Requests"** arriba, sólo si hay solicitudes recibidas
  pendientes, con su contador (`requestsPending`). Fila: nombre del
  solicitante, el mensaje, la hora.
- Nueva sección **"Others"** junto a las agrupaciones por evento: las
  aceptadas (de los dos lados) y las enviadas pendientes o rechazadas, con una
  etiqueta "Pending" / "Declined".
- La cabecera de la fila y del hilo dice el origen: "{nombre} · Vendor profile"
  (en vez del nombre del evento).
- Hilo de una solicitud recibida: el mensaje completo y, en lugar del cuadro de
  texto, "Accept" / "Decline" (rechazar pide confirmación: no se puede
  deshacer). Tras aceptar, el cuadro de texto normal.
- Hilo de una enviada pendiente: el cuadro sustituido por "Waiting for
  {businessName} to accept your request"; rechazada: "Declined · You can ask
  again from their profile on {fecha}".
- El contador global de "Messages" (`AppLayout`) suma
  `unreadTotal` de conversaciones + salas + perfil + `requestsPending`.

### 5.3 Datos y estado

- `messaging-api`: zod para las rutas nuevas, `kind: z.literal('PROFILE')`
  discrimina como en la sala.
- `messaging-store`: carga `GET /me/profile-conversations` junto a las otras
  dos, se suscribe a `contact.updated` (relee) y recarga al reconectar. Un
  `message.created` de una conversación desconocida que resulte ser de perfil
  también provoca la relectura.
- Rediseño vigente: tokens en variables CSS, tema oscuro por tokens, iconos con
  `createIcon`, `AppNavbar`; sin valores arbitrarios.

### 5.4 Pruebas

API (zod de cada ruta nueva y de los errores con `retryAt`); store (carga,
contadores, `contact.updated`, reconexión); UI: botón en la ficha en cada
estado (sin sesión → login con vuelta), diálogo de solicitud, "Request sent",
Declined con fecha, sección Requests con su contador, aceptar y rechazar (con
confirmación), hilo normal tras aceptar.

## 6. Lo que queda al builder

Nombres internos, forma exacta de las columnas y del enum, si `GET
/vendors/:vendorId/contact` y `POST` viven en un controlador nuevo del módulo
`messaging`, cómo obtiene `messaging` la ficha por `vendorId` (lectura directa
de `vendor_profiles` desde su repositorio, como ya hace con `businessName`, o un
puerto público de `vendors`; nunca su `infrastructure/`), el diseño fino del
diálogo y de las secciones dentro de los tokens.

## 7. Entrega

Ramas `feat/mensajeria-perfil` en los dos repos, desde `develop`; PR contra
`develop`, primero el del backend.
