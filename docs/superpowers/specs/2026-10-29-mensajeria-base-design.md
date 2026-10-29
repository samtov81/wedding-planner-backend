# Mensajería — parte 1: base del chat

Fecha: 2026-10-29. Abarca backend y frontend. Es la primera de cuatro partes de
la mensajería; §2 resume las cuatro para que esta deje sitio a las demás, pero
sólo la parte 1 se construye ahora.

## 1. Intención

La app no tiene forma de que las personas se escriban: la pareja, sus planners
y sus proveedores se coordinan por fuera (WhatsApp, correo). Queremos un chat
dentro de la app, claro como WhatsApp: siempre se sabe de dónde viene cada
mensaje, quién lo escribió, a qué hora y qué día, y si el otro lo recibió y lo
leyó.

Lo que el usuario fijó en la conversación:

- El chat sirve para comunicar a cualquier usuario, pero dos usuarios sin
  relación sólo se conectan desde el perfil público de un proveedor (parte 3).
- La primera vez que alguien sin relación te escribe, aceptas o rechazas
  (parte 3).
- Dentro de un evento: conversaciones individuales **y** una sala de grupo del
  evento (parte 2). **Los proveedores no ven la sala.**
- Una conversación nacida en el perfil de un proveedor se queda donde nació,
  aunque luego lo contraten; el chat del evento con ese proveedor es otro.
- Vista completa "Messages" (bandeja agrupada por evento + conversación) **y**
  panel flotante 💬 junto a la campana (parte 4).
- Sólo texto en esta versión.
- Anti-objetivo del usuario: mensajes sin origen claro, sin fecha u hora. Todo
  agrupado por fecha con etiqueta, como WhatsApp. Boceto aceptado (§5.2).

## 2. Las cuatro partes

1. **Base (este documento):** conversaciones individuales entre personas del
   mismo evento, texto, hora y separadores de fecha, estados
   enviado/recibido/leído, tiempo real, página "Messages".
2. **Sala del evento:** conversación de grupo por evento con la pareja y los
   planners (sin proveedores), "leído por N de M".
3. **Contacto desde el perfil:** botón en la ficha pública del proveedor,
   solicitud con aceptar/rechazar, sección "Otros" de la bandeja.
4. **Panel flotante 💬:** acceso rápido desde la barra superior, con contador
   propio.

Aceptado por el usuario como propuesta mía (válido para todas las partes):
sin editar ni borrar mensajes; sin bloquear ni denunciar (en la parte 3, el
rechazo es la defensa); avisos sólo dentro de la app (contador y tiempo real),
sin correo ni sonido, y **sin** entradas en la campana 🔔; 2.000 caracteres por
mensaje; historial paginado hacia atrás.

## 3. Objetivos, no objetivos, anti-objetivos (parte 1)

**Objetivos**

- Cualquier persona con acceso a un evento (miembro ACTIVE —pareja o planner— o
  proveedor `BOOKED` de un evento publicado) puede abrir una conversación
  individual con otra persona con acceso a ese mismo evento, y escribirle texto.
- Página `/messages` con la bandeja (conversaciones agrupadas por evento,
  último mensaje, no leídos) y la conversación abierta.
- Cada mensaje con remitente claro, hora, separadores de fecha y estado
  enviado/recibido/leído; llegan y se actualizan en tiempo real.
- Contador global de no leídos en el acceso a "Messages".

**No objetivos (parte 1)**: sala del evento, contacto desde perfiles,
solicitudes, panel flotante, adjuntos, edición/borrado, bloqueo, correo.

**Anti-objetivos**

- Un mensaje sin cabecera de origen, sin hora o sin separador de día.
- Que alguien lea o escriba en una conversación de la que no es participante.
- Que alguien abra una conversación con una persona con la que no comparte
  evento (eso es la parte 3, con solicitud).
- Que el estado mienta: "leído" sólo cuando el destinatario tuvo la
  conversación abierta con el mensaje cargado.

## 4. Reglas

### 4.1 Conversación individual de evento

- **Quién con quién (decidido por el usuario):** miembro ↔ miembro y miembro ↔
  proveedor. **Nunca proveedor ↔ proveedor**: un proveedor no puede escribir a
  otro proveedor del mismo evento ni verlo en la lista de contactos (son
  posible competencia). Un proveedor sólo ve como contactos a la pareja y los
  planners ACTIVE del evento.
- "Acceso al evento" para mensajería = miembro ACTIVE (pareja o planner, esté
  el evento publicado o no) o proveedor `BOOKED` de un evento publicado. Los
  administradores del sistema (`EventAccess.kind: 'admin'`) **no** participan
  por serlo: sólo si además son miembros o proveedores. Un miembro `INVITED`
  aún no tiene acceso. **[decisión de diseño]**
- Se identifica por **el evento + las dos personas** (sin orden). Hay como
  mucho una por trío; abrirla otra vez devuelve la existente. Si alguien
  recupera el acceso (un miembro reinvitado que acepta, un proveedor
  recontratado), vuelve a ver la misma conversación con su historial y puede
  escribir de nuevo. **[decisión de diseño]**
- Puede abrirla cualquiera de las dos si **ambas** tienen hoy acceso al evento.
- Escribir exige que **quien escribe** tenga acceso hoy. Leer exige ser
  participante y, además:
  - un **miembro** que salió del evento la sigue viendo **en solo lectura**;
  - un **proveedor** cuya contratación se canceló (o el evento dejó de estar
    publicado) **deja de verla**, igual que pierde el acceso al evento.
- Si el otro participante perdió el acceso, la conversación sigue abierta para
  quien lo conserva, pero escribir en ella se rechaza (no hay nadie que pueda
  leerlo con garantías): ambos ven solo lectura. **[decisión de diseño]**

### 4.2 Mensajes

- Texto de 1 a 2.000 caracteres tras recortar espacios; se guarda tal cual (sin
  HTML; el frontend lo pinta como texto).
- Orden total por (`createdAt`, `id`). Paginación por cursor hacia atrás, 50
  por página.
- Hora y fecha las pone el servidor (`createdAt`); el frontend las muestra en
  la zona horaria del navegador de quien lee.

### 4.3 Recibido y leído

Por participante se guardan dos marcas: **recibido hasta** y **leído hasta**
(el `createdAt`+`id` del último mensaje). Un mensaje del otro está:

- **enviado** (✓) si el destinatario no lo ha recibido,
- **recibido** (✓✓) si `recibido hasta` del destinatario lo alcanza,
- **leído** (✓✓ resaltado) si `leído hasta` lo alcanza.

El cliente del destinatario marca **recibido** al recibirlo por socket o al
cargar la bandeja/la conversación, y **leído** al tener la conversación
abierta y visible con ese mensaje cargado. Las marcas sólo avanzan (marcar algo
anterior no retrocede). **[decisión de diseño]**: marcas por participante y no
estado por mensaje, porque una marca es una escritura por lectura en vez de una
por mensaje, y sirve igual para la sala (parte 2: "leído por N de M" = cuántos
tienen `leído hasta` ≥ mensaje).

No leídos de una conversación = mensajes del otro posteriores a mi `leído
hasta`. El contador global suma las conversaciones que puedo ver, también las
de solo lectura. Marcar recibido/leído se permite en solo lectura (leer no es
escribir); `upTo` tiene que ser un mensaje de esa conversación (si no, 404).
**[decisión de diseño]**

## 5. Cómo se construye

### 5.1 Backend

Módulo nuevo `messaging` con las cuatro capas de siempre; la regla de acceso al
evento NO se duplica: se consulta a `EventAccessService` (puerto público de
`EventsModule`) o se expresa como filtro de datos con el mismo criterio que ya
usan las notificaciones (ACTIVE / BOOKED + evento publicado). Si es lo segundo,
con su paridad, como en `notifications`.

Datos (nombres finales del builder, migración con su entrada en
`docs/DATABASE.md`):

- `Conversation`: `id`, `kind` (`EVENT_DIRECT` en esta parte; el enum deja
  sitio a `EVENT_ROOM` y `PROFILE` de las partes 2 y 3), `eventId` (nullable
  por la parte 3), `pairKey` único (evento + ids ordenados) para la regla de
  "una por trío", `createdAt`, `lastMessageAt`.
- `ConversationParticipant`: `conversationId`, `userId`, marcas `deliveredUpTo`
  / `readUpTo` (instante + id del mensaje), único por par.
- `Message`: `id`, `conversationId`, `senderId`, `body`, `createdAt`; índice por
  (`conversationId`, `createdAt`, `id`). `CHECK` de longitud en la base, como
  el resto de restricciones del proyecto.

Rutas (todas con `JwtAuthGuard`, validación Zod con `validarCon`):

- `GET /me/conversations` → bandeja: por conversación visible, el otro
  participante (`userId`, `displayName`, `role`: `COUPLE` | `PLANNER` |
  `VENDOR`), el evento (`id`, `name`), último mensaje, `unreadCount`,
  `readOnly`; más `unreadTotal`. Para un proveedor, `displayName` es el
  `businessName` de su ficha (es como lo conoce la pareja); para un miembro, su
  `fullName`. **[decisión de diseño]**
- `GET /events/:eventId/contacts` → las personas a las que yo puedo escribir en
  ese evento según §4.1 (sin mí, sin proveedores si soy proveedor), con
  `userId`, `displayName`, `role`. Alimenta "New message". Exige acceso al
  evento en el sentido de §4.1. **[decisión de diseño]**
- `POST /events/:eventId/conversations` `{ userId }` → abre o devuelve la
  conversación (403/404 según las reglas de §4.1).
- `GET /conversations/:id/messages?cursor` → página de mensajes (más reciente
  primero) con las marcas del otro participante para pintar los estados.
- `POST /conversations/:id/messages` `{ body }` → 201 con el mensaje.
- `POST /conversations/:id/delivered` y `.../read` `{ upTo: messageId }` → 204.
- Límite de ritmo propio para enviar (`@LimiteDeRuta`), p. ej. 30/min por
  usuario. **[decisión de diseño]**

Tiempo real (socket `/realtime` existente, sala `user:<id>`):

- `message.created` `{ conversationId, message }` a los participantes.
- `message.receipt` `{ conversationId, userId, deliveredUpTo, readUpTo }` al
  otro participante cuando avanzan las marcas.
- Se emiten tras el commit por la cola, como el resto del proyecto (ruling C23
  citado en el código); cola propia del módulo (ruling C17). Un fallo al
  encolar se registra y se traga: el REST es el canal, el socket es latencia.
- El worker vuelve a comprobar, por destinatario, que todavía puede ver la
  conversación antes de emitirle el mensaje: un proveedor cancelado entre el
  envío y el aviso no debe recibir el texto por socket. **[decisión de
  diseño]**

### 5.2 Frontend

- Entrada "Messages" en el menú, fuera de los eventos (junto a Dashboard y
  Profile), con el contador `unreadTotal`; ruta `/messages` y
  `/messages/:conversationId`.
- Bandeja a la izquierda agrupada por evento (cabecera con el nombre del
  evento), cada fila con el otro participante, su rol, el último mensaje, la
  hora/fecha corta y los no leídos; botón "New message" que deja elegir evento
  y persona (sólo quien tiene acceso). En móvil, bandeja y conversación son dos
  pantallas.
- Conversación a la derecha, como el boceto aceptado
  (`.superpowers/brainstorm/…/conversacion.html` en el repo frontend):
  - cabecera con el origen: "{nombre} · {rol} · {evento}";
  - mis mensajes a la derecha, los del otro a la izquierda;
  - cada burbuja con su hora `HH:MM`;
  - separadores de día: "Today", "Yesterday", el día de la semana dentro de los
    últimos 7 días ("Monday, Oct 20"), y la fecha completa si es más antigua
    ("Sep 12, 2026") — en inglés como toda la UI;
  - estados en mis mensajes: ✓ enviado, ✓✓ recibido, ✓✓ resaltado leído, con
    texto oculto para lectores de pantalla;
  - solo lectura: el cuadro de texto se sustituye por un aviso
    ("You can no longer reply in this conversation").
- Store de mensajería atado a la sesión (patrón de `notifications-store`),
  suscrito a `message.created` / `message.receipt` y recargando al reconectar.
- Tokens del sistema de diseño, modo oscuro por tokens, sin valores
  arbitrarios.

## 6. Pruebas

Backend: unitarios de los casos de uso contra dobles; integración del
repositorio en Postgres (incluidos `pairKey` único y el `CHECK`); paridad si se
expresa el acceso como filtro de datos; e2e: abrir conversación (misma persona
dos veces → misma conversación), enviar, listar, paginar, marcas que sólo
avanzan, 403 a quien no es participante, 403 al abrir con alguien de otro
evento, 403 de proveedor a proveedor (y el proveedor no ve a otros
proveedores en `/contacts`), un admin del sistema no miembro no puede abrir
conversaciones, miembro que sale → solo lectura, proveedor cancelado → no la ve,
límite de ritmo; socket: el otro participante recibe `message.created` y el
emisor `message.receipt`.

Frontend: separadores de fecha (hoy, ayer, semana, antiguo, cambio de año),
hora en la zona del navegador, estados ✓/✓✓/leído, solo lectura, bandeja
agrupada y contador, marcar recibido/leído (leído sólo con la conversación
visible), tiempo real y reconexión.

## 7. Lo que queda al builder

Nombres internos, la forma exacta de las tablas y de los payloads de socket,
cómo se implementa "visible" para marcar leído (foco de la pestaña /
`visibilitychange`), y el diseño fino de la bandeja dentro de los tokens.
