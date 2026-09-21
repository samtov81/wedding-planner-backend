# Backend — bloque A: endurecimiento

> Diseño aprobado en conversación el 2026-09-18. Es la segunda tanda sobre la rama
> `worktree-backend-nucleo-invitados`, que implementó
> `2026-09-17-backend-nucleo-invitados-design.md`. Esa spec sigue siendo la
> autoridad para todo lo que este documento no cambia.
>
> Fuente de los hallazgos: la revisión final de rama y el ledger
> `.superpowers/sdd/2026-09-17-backend-nucleo-invitados/progress.md`.

## 1. Alcance

Endurecer lo construido, sin funcionalidad nueva de cuentas. Cinco áreas: el
RSVP modificable, dos decisiones de configuración, la estabilidad de la suite,
los seguimientos de seguridad y la limpieza.

Queda FUERA y va al bloque B (spec propia): verificación de email, aceptar
invitación de miembro, recuperar/restablecer contraseña, `PATCH /events/:id`,
`DELETE /events/:id/members/:userId`, OpenAPI desde Zod, y el worker de la cola
`email` (hoy sin consumidor; B construye justo esos workers).

## 2. RSVP modificable

Cambia la regla de la spec original ("token de un solo uso"). Decisión del
usuario: el invitado puede reabrir el enlace y **cambiar** su respuesta.

- **`Event.rsvpDeadlineDays`**: `Int`, por defecto `14`, rango 0–365. Migración
  nueva. `POST /events` lo acepta opcional. Editarlo después es de B
  (`PATCH /events/:id`).
- **Cierre**: `cierre = weddingDate − rsvpDeadlineDays días`.
- **Lectura** (`GET /rsvp/:token`): vale si `expiresAt > ahora`, en cualquier
  estado (también RESPONDED, también tras el cierre). Devuelve la vista con la
  respuesta actual y un campo nuevo `rsvpClosesAt` (ISO 8601).
- **Respuesta** (`POST /rsvp/:token`): vale si `expiresAt > ahora` y
  `ahora < cierre`. Una invitación RESPONDED puede responderse otra vez.
- **Errores**: token inexistente, malformado o caducado → el mismo 404
  `INVITATION_INVALID` de siempre. Token válido pero pasado el cierre → 422
  `RSVP_CLOSED`. Distinguirlo no filtra nada: para verlo hay que tener un
  token válido.
- **Monotonía**: el RSVP puede escribir RESPONDED sobre CUALQUIER estado,
  incluido RESPONDED. Nada más cambia: el webhook de Resend sigue sin poder
  pisar RESPONDED, y `marcarEnviada` tampoco.
- **Guarda en la escritura**: `marcarRespondida` sigue siendo un `UPDATE`
  condicionado (`expiresAt > ahora`). El cierre se comprueba en la lectura: sus
  dos datos (`weddingDate`, `rsvpDeadlineDays`) no los escribe el flujo del
  RSVP, así que no hay carrera propia que cerrar.
- **Avisos**: el jobId del aviso deja de ser `rsvp-<invitationId>` (BullMQ
  descartaría el segundo cambio del mismo invitado) y pasa a ser único por
  respuesta: `rsvp-<invitationId>-<epochMs>`. Cada cambio crea su
  `Notification`.
- **Efecto en C24**: `caducarVigentesDe` pasa a caducar TAMBIÉN las
  invitaciones RESPONDED. Si no, el enlace enviado a un email mal tecleado
  seguiría pudiendo cambiar el RSVP del invitado real.
- El límite del POST (5/min) no cambia.

## 3. Configuración

- `engine-strict=true` en `.npmrc`: `npm install`/`npm ci` con Node < 22.12
  fallan en vez de avisar.
- El webhook de Resend sale del limitador `global` y lleva uno propio,
  `webhook`, de 1200/min por IP. La firma Svix sigue siendo la barrera; este
  límite sólo acota la inundación de peticiones sin firmar.
- CI deja de compilar dos veces.

## 4. Estabilidad de la suite

Síntoma: ~1 de cada 4 ejecuciones completas falla en tests de alto volumen
(spraying de login → 400 en vez de 429, paginación HTTP → `socket hang up`,
`/health` → 403 que ningún código de la app produce).

- Diagnóstico primero: capturar cabeceras y cuerpo del 403. Sin
  `x-request-id` ⇒ no es nuestra app.
- Hipótesis a confirmar o descartar: supertest sobre un servidor que no
  escucha abre un puerto efímero por petición.
- Arreglo: el helper de tests levanta el servidor UNA vez por fichero con
  `listen(0)` y expone su URL; limpieza de las claves del throttler entre
  tests; cada e2e crea sus propios datos (fuera el acoplamiento por orden).
- Criterio de hecho: 10 ejecuciones completas seguidas en verde.

## 5. Seguridad

- **Refresh (C10)**: la revocación de familia y la rotación se serializan con
  `pg_advisory_xact_lock` por familia.
- **Jobs atascados**: respaldo en el evento `failed` del worker de
  invitaciones — si el job ya no tiene intentos, se caduca la invitación.
- **Ids mal formados** → 404, no 500: parámetros de ruta `guestId` y
  `eventVendorId`, y el `id` del cursor. **P2025** en PATCH concurrente → 404.
- **Sockets**: desconexión al `exp` del token; límite de ritmo en `join`.
- **Swagger**: apagado en producción salvo `DOCS_ENABLED=true`.
- **Entorno**: `APP_URL` sólo http/https; `JWT_ACCESS_TTL` validado y vacío =
  por defecto; un error de entorno no oculta otros; `example.com`/`.net`/`.org`
  cuentan como remitentes de prueba.
- **JWT**: `verify` exige `HS256`.
- **Errores**: el 401 del guard lleva `code: 'UNAUTHORIZED'`, no `HTTP_ERROR`.
- **Logs**: se redactan `x-original-uri`, `x-forwarded-uri` y `x-rewrite-url`;
  el worker registra por qué descarta un job; el webhook registra (debug) un
  `messageId` sin casar.
- **Envíos**: un 409 de idempotencia de Resend cuenta como enviado;
  `UnrecoverableError` se reconoce también por nombre.
- **Auditoría**: actualizar y borrar un proveedor dejan `AuditLog`. El
  metadata de auditoría NO lleva datos personales: sólo `kind` y
  `vendorProfileId`/`eventVendorId`, nunca nombre, email ni teléfono.
- **Invitados**: `PATCH` acepta `email: null`.
- **Código muerto**: fuera `@nestjs/jwt` y `SessionRepository.revocar`.

## 6. Limpieza

- ESLint: de 25 avisos a 0.
- dependency-cruiser deja de excluir los tests: regla propia que sólo les deja
  importar la `infrastructure/` de otro módulo si es un `*.fake.ts`.
- Paridad doble/Prisma: cursor de invitados, `crear` de invitaciones,
  repositorio de notificaciones, `caducar` contra Postgres.
- Tests unitarios que faltan: `RegisterUseCase`, `LogoutUseCase`,
  `TokenService`, el 400 del PATCH vacío.
- Fuera el test tautológico; el smoke de SIGTERM comprueba un cierre ordenado
  real; el fichero de tests mal nombrado se parte.
- README: `TRUST_PROXY` obligatorio detrás de un balanceador.

## 7. Se acepta como está

`npm run dev` sin watch; `q` sin escapar `%`/`_`; el login cuenta también los
intentos correctos.
