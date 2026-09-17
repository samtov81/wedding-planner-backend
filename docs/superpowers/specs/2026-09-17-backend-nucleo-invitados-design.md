# Backend — núcleo de plataforma + vertical de invitados/RSVP

Fecha: 2026-09-17
Estado: aprobado, pendiente de plan de implementación
Repos implicados: `wedding-planner-backend` (nuevo), `wedding-planner-frontend` (existente, no se modifica)

## 1. Contexto

`wedding-planner-backend` está vacío: un `README.md` de 25 bytes y un commit inicial.
Todo se decide aquí.

`wedding-planner-frontend` es un sistema de diseño + pantallas con 14 features
(`auth`, `booking`, `budget`, `dashboard`, `guests`, `invoices`, `messaging`,
`moodboard`, `planning`, `seating`, `settings`, `system`, `timeline`, `vendors`)
y sin backend. Su dominio ya está descrito en Zod: cada feature tiene un
`mocks.ts` cuyos `refine` codifican invariantes reales del negocio, verificados
por `mocks.test.ts`. Esos esquemas son la mejor documentación de dominio
disponible y se usan como fuente de referencia, no como dependencia.

Dos decisiones del frontend se heredan porque son correctas y porque divergir de
ellas crearía incoherencias entre repos:

- **Los agregados se derivan de las filas, nunca se persisten sueltos.** El
  frontend lo hace porque los totales del export de Stitch contradicen sus
  propias tablas. El backend lo hace porque una columna de contador se
  desincroniza.
- **`faker` no se usa.** La 6.6.6 está comprometida. Donde haga falta variación,
  PRNG determinista (mulberry32), como en `features/guests/mocks.ts`.

## 2. Alcance

Este documento cubre **el núcleo transversal de la plataforma más un único
dominio vertical completo**: invitados y RSVP.

El vertical no es un ejemplo decorativo. Es el que obliga a que cada pieza de
infraestructura exista de verdad: CRUD paginado y filtrable, envío masivo de
correo por cola con reintentos, webhook entrante del proveedor de correo,
endpoint público sin sesión, y notificación en tiempo real. Una base construida
sin ningún caso que la atraviese acaba con las abstracciones equivocadas.

Los 13 dominios restantes se añaden después replicando un patrón ya probado, con
su propio ciclo de spec, plan e implementación.

### Fuera de alcance, deliberadamente

Pagos y pasarela; almacenamiento de ficheros (S3) y todo lo que depende de él
(moodboard, ficheros compartidos, contratos firmados); GraphQL; i18n;
OpenTelemetry; multi-región. Ninguno lo necesita este vertical, y cada uno
arrastra decisiones que merecen su propia ronda de diseño.

## 3. Decisiones tomadas

| Decisión | Elección | Por qué |
|---|---|---|
| Framework | NestJS | Trae DI, módulos, guards, interceptores y adaptadores oficiales de Socket.IO y BullMQ. La arquitectura la impone el framework en vez de mantenerse a mano. |
| ORM | Prisma | Migraciones versionadas, tipado generado, consultas parametrizadas por defecto. |
| Base de datos | PostgreSQL | Restricciones `CHECK`, índices parciales, `jsonb`. La integridad se declara en el esquema. |
| Runner de tests | Vitest | Mismo runner que el frontend: una sola cultura de tests entre repos. |
| Contrato con el frontend | OpenAPI generado | El backend es fuente de verdad y publica OpenAPI generado desde sus Zod (`nestjs-zod` + `@nestjs/swagger`). Los repos siguen independientes; la divergencia la detecta la generación del cliente. |
| Actores | 4 roles: pareja, vendor, planner, admin | Requisito de producto. |

## 4. Arquitectura

### 4.1 Estructura

Clean Architecture **por módulo**, no global. La alternativa —cuatro carpetas de
nivel raíz con todos los dominios dentro de cada una— se descarta: con 14
features obliga a navegar cuatro árboles para tocar una sola cosa, y los módulos
de NestJS ya son la unidad natural de agrupación.

```
src/
  main.ts
  app.module.ts
  config/                     env tipado y validado con Zod al arrancar
  shared/                     kernel: errores de dominio, paginación, tipos base
  modules/
    <dominio>/
      domain/                 entidades puras, value objects, puertos, errores
      application/            un fichero por caso de uso + DTOs Zod
      infrastructure/         repositorios Prisma, adaptadores (Resend, Redis, socket)
      interfaces/             controllers HTTP, gateways WS, processors de cola
      <dominio>.module.ts
  prisma/
test/                         e2e con Testcontainers
```

Módulos del núcleo: `config`, `database`, `auth`, `users`, `events`, `vendors`,
`mail`, `queue`, `realtime`, `notifications`, `health`.
Módulo vertical: `guests`.

El módulo `vendors` entra en este alcance **sólo parcialmente**: aporta
`VendorProfile` como modelo y los endpoints de gestión de `EventVendor` (§8).
El marketplace en sí —búsqueda y filtrado de proveedores, paquetes de servicio,
portfolio, ficha pública— queda fuera, con el resto de dominios.

### 4.2 Regla de dependencia — es un gate, no una convención

- `domain/` no importa **nada** externo: ni Prisma, ni NestJS, ni Zod.
- `application/` importa sólo `domain/`.
- `infrastructure/` e `interfaces/` importan hacia dentro, nunca al revés.
- Un módulo no importa el `infrastructure/` de otro módulo; se comunica por el
  puerto público que ese módulo exporta.

Lo vigila `dependency-cruiser` en CI. Precedente directo: el frontend no confía
en que nadie recuerde la regla de los tokens muertos, la comprueba con
`scripts/dead-tokens.mjs`. Una regla arquitectónica que sólo vive en la cabeza de
quien revisa se rompe en tres semanas.

## 5. Modelo de datos

```
User              id, email(unique), passwordHash(argon2id), fullName,
                  systemRole(USER|ADMIN), emailVerifiedAt, timestamps

Session           id, userId, tokenHash, familyId, expiresAt, revokedAt,
                  ip, userAgent
                  └ rotación de refresh con detección de reuso por familia

VendorProfile     id, userId(unique), businessName, category, specialty,
                  bio, contact(jsonb), status(DRAFT|PUBLISHED|SUSPENDED), timestamps
                  └ existe por sí solo, sin ningún evento

Event             id, name, weddingDate, timezone, venueLocation, ownerId, timestamps

EventMembership   id, eventId, userId, role(COUPLE|PLANNER),
                  status(INVITED|ACTIVE|REVOKED), invitedById, timestamps
                  UNIQUE(eventId, userId)
                  └ quienes PLANIFICAN el evento

EventVendor       id, eventId, category, specialty, assignedBudget,
                  status(SHORTLISTED|BOOKED|CANCELLED),
                  vendorProfileId?          ── enlazado al marketplace
                  externalName?, externalEmail?, externalPhone?   ── sin cuenta
                  CHECK: exactamente uno de los dos lados presente
                  └ quien TRABAJA en el evento: relación comercial, no membresía

Guest             id, eventId, name, email, group, rsvp(CONFIRMED|PENDING|DECLINED),
                  dietary?, timestamps
                  UNIQUE(eventId, email)

GuestInvitation   id, guestId, tokenHash(unique), status(QUEUED|SENT|DELIVERED|
                  BOUNCED|COMPLAINED|RESPONDED), resendMessageId?,
                  sentAt?, respondedAt?, expiresAt

Notification      id, eventId, userId, type, payload(jsonb), readAt?, createdAt

AuditLog          id, actorUserId?, eventId?, action, target, metadata(jsonb), createdAt
```

### 5.1 Por qué vendor no es una membresía

`EventMembership` y `EventVendor` son tablas distintas porque **la pertenencia y
la contratación tienen ciclos de vida distintos**. Una membresía se concede y se
revoca por decisión de acceso. Una contratación nace de un booking, lleva dinero
asociado, se cancela con consecuencias comerciales y debe sobrevivir en el
histórico aunque el vendor pierda el acceso. Si `VENDOR` fuese un rol de
`EventMembership`, revocar un acceso borraría un hecho comercial.

Separarlo además libera el perfil: un vendor puede registrarse, publicar su ficha
y aparecer en el marketplace **con cero eventos contratados**. Con el modelo
anterior no tendría dónde existir.

Esto corresponde con lo que el frontend ya modela por separado:
`vendors/mocks.ts` define `vendorProfileSchema` (stats, packages, portfolio,
contacto: una ficha global), y `settings/mocks.ts` define aparte
`assignedVendorSchema` (`category`, `specialty`, `budget`: el vínculo con una
boda concreta).

### 5.2 Vendors externos

`EventVendor` admite un proveedor sin cuenta en la plataforma: la pareja añade a
mano nombre, categoría y contacto. La exclusividad entre "enlazado" y "externo"
se garantiza con una restricción `CHECK` en Postgres **además** del value object
del dominio: la base de datos es la última línea y sobrevive a los bugs del
código.

`vendorProfileId` nulo no es una vía muerta: es el hueco por el que entra un
futuro flujo de "reclamar ficha" si ese proveedor acaba registrándose.

Consecuencia que el código debe tratar explícitamente: **todo lo que requiere una
cuenta (acceso al evento, chat, firma) tiene que saber que un `EventVendor` puede
no tener usuario detrás.** Los casos de uso devuelven un error de dominio
tipado, no un `null` silencioso.

### 5.3 Agregados

Los contadores de invitados por estado de RSVP se calculan con `GROUP BY` sobre
`Guest`. No existe ninguna columna de contador. Si el coste se vuelve un problema
medido, se cachean en Redis con invalidación por escritura — **nunca** se
persisten como fuente de verdad.

## 6. Autorización

Dos ejes, deliberadamente separados:

- **Rol global** — `User.systemRole`, con dos valores. Responde "¿es admin de la
  plataforma?".
- **Acceso por evento** — responde "¿qué es esta persona *en esta boda*?".

Aplanar ambos en un único `user.role` hace imposible representar al planner que
gestiona 12 bodas y además se casa: sería `PLANNER` y `COUPLE` a la vez.

El acceso por evento tiene ahora dos fuentes (`EventMembership` y `EventVendor`),
así que se resuelve en **un solo sitio**: `EventAccessService.resolve(userId,
eventId)` devuelve un acceso efectivo tipado:

```ts
type EventAccess =
  | { kind: 'admin' }
  | { kind: 'member'; role: 'COUPLE' | 'PLANNER' }
  | { kind: 'vendor'; eventVendorId: string; status: 'BOOKED' }
  | { kind: 'none' }
```

Sobre él, un `EventAccessGuard` que lee el `:eventId` de la ruta y un decorador
`@RequireEventAccess('COUPLE', 'PLANNER')`. Los controladores no consultan
tablas. **El mismo servicio autoriza la entrada a las salas de socket**, así que
REST y tiempo real no pueden divergir en sus permisos.

**Ausencia de acceso se responde `404`, no `403`.** Un `403` confirma que el
evento existe a quien no debería saberlo; con eventos identificados por id
adivinable eso es un oráculo de enumeración. `403` se reserva para quien sí tiene
acceso al evento pero no permiso para esa operación concreta.

Reglas del vertical:

- Leer invitados: `COUPLE`, `PLANNER`, `admin`.
- Escribir invitados y enviar invitaciones: `COUPLE`, `PLANNER`, `admin`.
- Vendor: **sin acceso** a la lista de invitados en este alcance. Un vendor
  contratado no necesita los datos personales de 150 personas; si en el futuro
  hace falta (el catering quiere las restricciones alimentarias), será un
  endpoint agregado y anonimizado, no acceso a la tabla.

## 7. El invitado no tiene cuenta

Los invitados responden el RSVP sin registrarse. Esto no pasa por el sistema de
auth:

- Cada `GuestInvitation` lleva un token opaco de alta entropía (32 bytes CSPRNG).
- **Sólo se guarda su hash.** Si se filtra la base de datos, no se obtienen
  enlaces válidos.
- Caduca, y al responder pasa a `RESPONDED`.
- Los dos endpoints públicos de RSVP son los únicos sin JWT del backend, y por
  eso llevan rate limiting propio por IP y por token, y devuelven el mínimo de
  datos necesarios (nombre del invitado, nombre y fecha del evento). Nunca la
  lista de invitados ni datos de otros.

## 8. API

Paginación **por cursor**, no por `offset`: el frontend pagina 150 invitados de 4
en 4, y `OFFSET` degrada con la profundidad y además salta filas cuando hay
inserciones concurrentes. El `?page=` del mock se traduce a `?cursor=&limit=`.

```
POST   /auth/register
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout
POST   /auth/verify-email
POST   /auth/forgot-password
POST   /auth/reset-password
GET    /auth/me

POST   /events
GET    /events                                   eventos a los que tengo acceso
GET    /events/:eventId
PATCH  /events/:eventId
POST   /events/:eventId/members                  invitar COUPLE o PLANNER
DELETE /events/:eventId/members/:userId

GET    /events/:eventId/vendors
POST   /events/:eventId/vendors                  enlazado o externo
PATCH  /events/:eventId/vendors/:eventVendorId
DELETE /events/:eventId/vendors/:eventVendorId

GET    /events/:eventId/guests                   ?cursor=&limit=&rsvp=&group=&q=
GET    /events/:eventId/guests/summary           agregados derivados
POST   /events/:eventId/guests
GET    /events/:eventId/guests/:guestId
PATCH  /events/:eventId/guests/:guestId
DELETE /events/:eventId/guests/:guestId
POST   /events/:eventId/guests/invitations       envío masivo → 202
POST   /events/:eventId/guests/:guestId/invitation   reenvío individual → 202

GET    /rsvp/:token                              público
POST   /rsvp/:token                              público

POST   /webhooks/resend                          firma Svix verificada

GET    /events/:eventId/notifications
POST   /notifications/:notificationId/read

GET    /health
GET    /health/ready
```

## 9. Flujo de referencia: invitación → RSVP → notificación

1. `POST /events/:eventId/guests/invitations`. El caso de uso valida el acceso,
   crea una `GuestInvitation` por invitado en estado `QUEUED` dentro de una
   transacción, encola un job por invitación y devuelve **`202 Accepted`**. La
   petición no espera a que salga ningún correo.
2. El worker de la cola `email` toma el job, renderiza la plantilla React Email y
   llama a Resend a través de `MailPort`. Guarda el `resendMessageId` y pasa la
   invitación a `SENT`.
3. Resend llama a `POST /webhooks/resend`. Se **verifica la firma Svix antes de
   mirar el cuerpo**. Se actualiza el estado a `DELIVERED`, `BOUNCED` o
   `COMPLAINED`, de forma idempotente por `messageId` + tipo de evento.
4. El invitado abre `GET /rsvp/:token`, responde con `POST /rsvp/:token`. En una
   transacción: se actualiza `Guest.rsvp`, la invitación pasa a `RESPONDED`, y se
   crean las `Notification` para los miembros del evento.
5. Se encola un job en `notifications`; el worker emite por Socket.IO a
   `event:<eventId>` y a `user:<userId>`.

### 9.1 Idempotencia

Los jobs usan **`jobId` determinista** (`invitation:<invitationId>`). Es la pieza
que hace seguros los reintentos: sin ella, un fallo de red *después* de que
Resend aceptara el correo produce un segundo envío al reintentar. Con ella,
BullMQ descarta el job duplicado.

### 9.2 El socket no es fuente de verdad

Toda emisión corresponde a una `Notification` ya persistida. Un cliente
desconectado se pierde el evento y lo recupera por REST al reconectar. El tiempo
real es una optimización de latencia sobre un estado que ya existe, no el canal
por el que el estado llega.

Invertir esto produce los bugs que no se reproducen: notificaciones que
existieron para quien estaba conectado y nunca para los demás.

Quien emite es el **worker**, no el proceso HTTP.

## 10. Infraestructura

### 10.1 Colas — BullMQ sobre Redis

Tres colas: `email`, `notifications`, `maintenance` (jobs repetibles).
Backoff exponencial, 5 intentos, retención acotada de completados, y los fallos
permanentes a una cola muerta con alerta.

Los casos de uso **no importan BullMQ**: encolan por un puerto de aplicación
(`QueuePort`) cuyo adaptador vive en `infrastructure/`. Bull Board se expone sólo
tras autenticación de admin.

### 10.2 Correo — Resend

`MailPort` en `application/`, adaptador Resend en `infrastructure/`. En tests, un
fake en memoria sobre el que se asserta; en desarrollo, uno que escribe a disco.
Cambiar de proveedor no toca ningún caso de uso.

Plantillas con React Email, renderizadas en el worker.

### 10.3 Tiempo real — Socket.IO

Handshake autenticado con el mismo access JWT; conexión rechazada si es inválido.
Salas `event:<eventId>` —entrada autorizada por `EventAccessService`— y
`user:<userId>`. `@socket.io/redis-adapter` para que varias instancias emitan a
sockets conectados a otra.

Eventos emitidos: `guest.rsvp.updated`, `guest.invitation.status`,
`notification.created`.

## 11. Seguridad

- `helmet`; CORS con allowlist explícita, nunca `*`; límites de tamaño de cuerpo.
- **Toda** entrada validada con Zod en un `ValidationPipe` global. El borde no
  conoce `any`.
- Argon2id para contraseñas. No bcrypt: ganador del PHC, con resistencia real a
  GPU/ASIC, mientras bcrypt sigue limitado a 72 bytes y a un coste sólo en CPU.
- Access JWT de ~15 min; refresh opaco con rotación por familia y detección de
  reuso (presentar un refresh ya usado sólo puede significar robo → se revoca la
  familia entera).
- Refresh en cookie `httpOnly; Secure; SameSite=Strict; path=/auth/refresh`.
  Access token en memoria del cliente, **nunca** en `localStorage`: un XSS no
  debe poder leerlo.
- Verificación de email obligatoria. Recuperación con token de un solo uso,
  caducidad corta, y **respuesta idéntica exista o no la cuenta** para no filtrar
  qué emails están registrados.
- Rate limiting con almacenamiento en Redis: global, más límites propios en login
  (por IP y por cuenta) y en los endpoints públicos de RSVP.
- `$queryRawUnsafe` prohibido por regla de lint.
- Secretos validados con Zod **al arrancar**: si falta uno, el proceso no
  arranca, en vez de fallar seis horas más tarde en producción.
- Logs estructurados con `pino`, con redacción de `authorization`, contraseñas y
  tokens.
- `AuditLog` para lo sensible: cambios de membresía, revocaciones, acciones de
  admin.
- Filtro global de excepciones que traduce errores de dominio a HTTP sin filtrar
  internals ni stacks en producción. Sin `X-Powered-By`.
- `faker` no se instala.

## 12. Testing y CI

Vitest, con `describe` y nombres de test **en español**, igual que el frontend.

- **Unitarios** — dominio y casos de uso contra dobles de los puertos. Sin IO,
  rápidos, son la mayoría.
- **Integración** — repositorios Prisma contra **Postgres real vía
  Testcontainers**. Nunca sqlite: un dialecto distinto produce verdes falsos
  justo en lo que el repositorio existe para hacer (restricciones, transacciones,
  el `CHECK` de `EventVendor`).
- **E2E** — supertest sobre la app completa, con Postgres y Redis en contenedores.

Un tipo de test que se omite siempre y aquí es obligatorio: **por cada endpoint,
un test por cada rol que NO debe poder acceder.** Un test de autorización que
sólo recorre el camino feliz no prueba nada.

CI: `typecheck`, `lint` + `dependency-cruiser`, tests, `build`, y comprobación de
que las migraciones de Prisma están al día respecto al esquema.

`docker-compose` para desarrollo local: Postgres, Redis y adaptador de correo
fake.

## 13. Observabilidad

`GET /health` (liveness) y `GET /health/ready` (readiness, con chequeo real de
Postgres y Redis). `requestId` generado en el borde y propagado a los logs y al
payload de los jobs, para poder seguir una petición desde el HTTP hasta el correo
que produjo.

## 14. Criterios de aceptación

1. `npm run typecheck`, `npm run lint` y `npm test` pasan en CI en verde.
2. `dependency-cruiser` falla el build si `domain/` importa Prisma o NestJS.
3. Un usuario puede registrarse, verificar su email, iniciar sesión, crear un
   evento e invitar a un planner.
4. Un planner con acceso a dos eventos ve sólo los invitados de cada uno, y un
   usuario sin membresía recibe `404` (no `403`: no se confirma la existencia del
   evento a quien no tiene acceso).
5. Un vendor contratado **no** puede listar los invitados del evento.
6. El envío masivo de invitaciones devuelve `202` y no bloquea; los correos salen
   por la cola; reintentar un job no envía un segundo correo.
7. Un webhook de Resend con firma inválida se rechaza sin tocar la base de datos.
8. Responder un RSVP actualiza al invitado, marca la invitación como `RESPONDED`,
   persiste las notificaciones y las emite por socket a la sala del evento.
9. Un token de RSVP ya usado o caducado se rechaza.
10. El endpoint de resumen devuelve contadores derivados con `GROUP BY`; no
    existe ninguna columna de contador en el esquema.
11. Arrancar sin una variable de entorno obligatoria falla inmediatamente y con
    un mensaje que nombra la variable.
12. `/openapi.json` refleja los esquemas Zod reales de los DTOs.
