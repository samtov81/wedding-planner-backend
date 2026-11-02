# Mensajería — parte 2: sala del evento (backend)

Fecha: 2026-11-02. Continúa `2026-10-29-mensajeria-base-design.md` (parte 1),
cuyo §2 sólo daba dos líneas para esta parte: "conversación de grupo por evento
con la pareja y los planners (sin proveedores), 'leído por N de M'". Las reglas
de abajo salen de la conversación con el usuario. Este documento cubre el
**backend**; el frontend de la sala tendrá su propio plan.

## 1. Intención

La pareja y sus planners necesitan un sitio común dentro de cada evento para
coordinarse todos a la vez, sin abrir N conversaciones 1:1 y sin que los
proveedores lo vean. Igual que en la parte 1: origen, hora y estado claros; en
grupo, el estado es "leído por N de M" y se puede ver quién lo leyó.

## 2. Reglas

### 2.1 Quién está en la sala (decidido por el usuario)

- La sala existe desde que existe el evento. Quien lo crea está en ella y la ve
  vacía.
- Entra todo miembro (pareja o planner) cuando pasa a **ACTIVE**. Quien entra
  tarde **ve todo el historial**.
- **Los proveedores nunca están en la sala**, ni un miembro `INVITED`, ni un
  administrador del sistema por serlo.
- Un miembro que pasa a **REVOKED** conserva la sala **en solo lectura**, pero
  **sólo hasta que salió**: lo escrito después no lo ve. Si vuelve a ser
  ACTIVE, escribe y ve todo de nuevo.

### 2.2 "Leído por N de M" (decidido por el usuario)

- **M es fijo por mensaje**: quienes estaban en la sala al enviarlo, sin el
  remitente. Ni las salidas posteriores ni los que entran después lo cambian.
- N = cuántos de esos M tienen su marca "leído hasta" ≥ el mensaje (las mismas
  marcas por participante de la parte 1, §4.3).
- El remitente puede ver **quién lo leyó y quién no**, sólo nombres (sin hora
  de lectura).

### 2.3 Decisiones de diseño

- **[decisión de diseño]** No leídos en la sala = mensajes en los que soy
  destinatario posteriores a mi "leído hasta". Así, quien entra tarde ve el
  historial pero empieza con 0 no leídos.
- **[decisión de diseño]** ✓✓ "recibido" = todos los destinatarios lo
  recibieron; "leído" = todos lo leyeron; además `N de M` explícito.
- **[decisión de diseño]** La sala se crea de forma perezosa e idempotente
  (`pairKey = 'room:<eventId>'`, `INSERT … ON CONFLICT DO NOTHING`) al abrirla
  o al listar las salas. Para el usuario "existe desde el principio"; así
  `events` no llama a `messaging` (evita un acoplamiento y un posible ciclo).
- **[decisión de diseño]** Los destinatarios de cada mensaje se guardan al
  enviarlo (`message_recipients`). Es lo único que fija M: no existe registro de
  fechas de entrada/salida de una membresía (se reutiliza la misma fila al
  reinvitar). La misma tabla da "hasta que salió" (el último mensaje en el que
  fue destinatario o remitente) y los no leídos del que entra tarde.
  Consecuencia aceptada: quien entró y salió sin que se enviara ningún mensaje
  mientras estaba no ve ninguno en solo lectura.
- **[decisión de diseño]** Las salas **no** salen en `GET /me/conversations` ni
  en su `unreadTotal`: el frontend de la parte 1 valida esa respuesta con zod y
  exige `other`; un elemento de sala rompería toda la bandeja. Van por
  `GET /me/rooms`; el frontend de la parte 2 las une.
- Escribir exige ser miembro ACTIVE hoy; marcar se permite en solo lectura
  sólo sobre mensajes visibles. Mismo límite de 2.000 caracteres y mismo
  limitador `messages` (30/min) que la parte 1.

## 3. Rutas

- `GET /me/rooms` → `{ items: Sala[], unreadTotal }`. `Sala` = `{ id, kind:
  'EVENT_ROOM', event{id,name}, memberCount, lastMessage, unreadCount,
  readOnly }`. Por evento donde soy ACTIVE (creando la sala si falta) más las
  de solo lectura de eventos de los que salí.
- `GET /events/:eventId/room` → la `Sala`. Proveedor, admin o sin membresía →
  403 `ROOM_ACCESS_DENIED`.
- `GET /conversations/:id/messages` en una sala → `{ items, nextCursor, marks }`;
  `marks` = por participante `{ userId, displayName, role, deliveredUpTo,
  readUpTo }`; mis mensajes llevan `recipientIds` y `receipts { total,
  delivered, read }`. En solo lectura, sólo hasta que salí.
- `POST /conversations/:id/messages`, `/delivered`, `/read`: como en la parte
  1, sobre la sala.
- `GET /conversations/:id/messages/:messageId/readers` → `{ read: Contacto[],
  unread: Contacto[] }`. Sólo el remitente; cualquier otro, 404.

## 4. Tiempo real

Mismo socket y mismos eventos que la parte 1:
`message.created` al remitente y a los destinatarios del mensaje (el worker
re-comprueba que aún pueden ver la sala); `message.receipt` `{ conversationId,
userId, deliveredUpTo, readUpTo }` a los participantes que la ven, salvo quien
marcó. El frontend de la parte 1 ignora ambos para conversaciones que no
conoce (salvo marcar entregado, que es correcto).

## 5. Pruebas

Unitarios de dominio y casos de uso; paridad doble/Prisma de las nuevas
operaciones del repositorio; integración (una sala por evento con concurrencia,
CHECK de la clave); e2e: el creador ve la sala vacía, un proveedor 403 y nunca
es destinatario, quien entra tarde ve historial con 0 no leídos, N de M sube al
leer, `readers` sólo para el remitente, un revocado lee hasta su salida y no
escribe, un readmitido vuelve a escribir y ver todo, sockets.
