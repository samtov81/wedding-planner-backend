# Recuperar contraseña (backend + frontend)

> Diseño aprobado en conversación el 2026-09-22. Ramas `feat/recuperar-contrasena`
> en `wedding-planner-backend` (desde `feat/sesion-y-reenvio-verificacion`) y en
> `wedding-planner-frontend` (desde `feat/sesion-y-router`). Depende de lo que
> esas ramas traen: login con email verificado, reenvío de verificación, router
> y `api-client`.

## 1. Alcance

Flujo completo de "olvidé mi contraseña": pedir el enlace, recibir el correo,
fijar la contraseña nueva y volver al login. Backend y frontend.

Decisiones del usuario:

- **Cuenta sin verificar**: recibe el enlace igual. Usarlo demuestra control
  del buzón, así que el reset también marca el email como verificado.
- **Tras el reset**: se revocan TODAS las sesiones del usuario, se envía un
  aviso "tu contraseña ha cambiado" y el frontend lleva al login. Sin
  auto-login: el enlace del correo nunca se convierte en una sesión.
- **Almacenamiento**: tabla propia `password_reset_tokens`, mismo patrón que
  `email_verification_tokens`. No se generaliza la tabla existente.

Fuera de alcance:

- Invalidar los access JWT ya emitidos. No tienen estado y siguen valiendo
  hasta su caducidad (`JWT_ACCESS_TTL`, 15 min por defecto). Cerrarlo exigiría
  consultar `passwordChangedAt` en cada petición autenticada; se acepta el hueco.
- Cambiar la contraseña con sesión iniciada (`PATCH /me/password`).
- Límite por cuenta (independiente de la IP) en `forgot-password`: mismo
  DESIGN-GAP que el login, abriría el bloqueo a propósito.

## 2. Modelo de datos

Migración nueva:

```prisma
enum PasswordResetStatus {
  PENDING
  CONSUMED
}

model PasswordResetToken {
  id         String              @id @default(uuid()) @db.Uuid
  userId     String              @db.Uuid
  tokenHash  String              @unique
  status     PasswordResetStatus @default(PENDING)
  consumedAt DateTime?
  expiresAt  DateTime
  createdAt  DateTime            @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("password_reset_tokens")
}
```

- Token en claro: 32 bytes de `randomBytes`, en base64url. Solo se persiste el
  SHA-256 (`hashToken` de `token.service.ts`). El token en claro existe
  únicamente en el payload del job (con `removeOnComplete`) y en el correo.
- Caducidad: `PASSWORD_RESET_TTL_MINUTES`, entero positivo, por defecto **30**.
- Un solo token vivo por usuario: al emitir uno nuevo se caducan los PENDING
  vigentes (`expiresAt = ahora`).

Puerto `PasswordResetTokenRepository` (`auth/application/`):

```ts
crear(datos: { userId; tokenHash; expiresAt }): Promise<{ id: string }>
caducarVigentesDe(userId: string, ahora: Date): Promise<void>
/** CAS PENDING→CONSUMED si expiresAt > ahora. Devuelve userId y tokenId, o null. */
consumirPorHash(tokenHash: string, ahora: Date): Promise<{ userId: string; tokenId: string } | null>
```

A diferencia de la verificación, aquí no hay resultado `YA_CONSUMIDO` amigable:
un token usado, caducado o inexistente es el mismo error para el cliente.
El adaptador Prisma escribe con `clienteDe(this.prisma)` porque participa en la
unidad de trabajo. Fake en memoria con test de paridad contra Prisma, como el
de verificación.

Puertos existentes que crecen:

- `UserRepository.actualizarPassword(id, passwordHash)`: actualiza el hash y
  pone `emailVerifiedAt = now()` si era null. Escribe con `clienteDe`.
- `SessionRepository.revocarTodasDeUsuario(userId)`: `revokedAt = now()` en
  todas las sesiones vivas del usuario. Escribe con `clienteDe`.

## 3. Endpoints

### `POST /auth/forgot-password`

- Cuerpo: `{ email }` (Zod, `z.email()`).
- Respuesta: **siempre `202 { ok: true }`**: cuenta inexistente, verificada o
  sin verificar son indistinguibles.
- `ForgotPasswordUseCase` copia la estructura de `ResendVerificationUseCase`:
  normaliza el correo (`trim().toLowerCase()`), una consulta `findByEmail` y,
  si existe, lanza el trabajo **sin `await`** (con `.catch` que registra):
  caducar vigentes → crear token → encolar `send-password-reset-email`.
  Así el tiempo de respuesta no depende del estado de la cuenta.
- Límite: `LIMITADOR_FORGOT_PASSWORD`, **3 por hora por IP + correo**
  (`rastreoPorIpYCorreo`), además del global por IP.

### `POST /auth/reset-password`

- Cuerpo: `{ token: string (min 1), password: string (8..128) }`. El máximo de
  128 evita que alguien obligue a Argon2 a trabajar con entradas enormes.
- `ResetPasswordUseCase`:
  1. `hasher.hash(password)` **fuera** de la transacción (el Argon2 no retiene
     una conexión).
  2. En `UnidadDeTrabajo.ejecutar`:
     - `consumirPorHash(hashToken(token), ahora)`; si `null` →
       `TokenResetInvalidoError`.
     - `usuarios.actualizarPassword(userId, hash)` (marca verificado si hacía falta).
     - `sesiones.revocarTodasDeUsuario(userId)`.
     - `tokens.caducarVigentesDe(userId, ahora)`.
  3. Tras confirmar, encola `send-password-changed-notice` (con `await`: aquí
     no hay nada que ocultar, quien llama ya tiene un token válido). Si el
     encolado falla, se registra y **no** se falla la petición: la contraseña
     ya cambió.
- Respuesta: `200 { ok: true }`.
- Error: `TokenResetInvalidoError` → **422 `RESET_TOKEN_INVALID`** (`UnprocessableError`, como `RSVP_CLOSED`; vía
  `DomainExceptionFilter`), igual para token inexistente, caducado o usado.
- Límite: `LIMITADOR_RESET_PASSWORD`, **10 cada 15 min por IP**.
- El cambio de contraseña no crea sesión: no se toca la cookie `wp_refresh`.

## 4. Correos

Cola `email`, procesador `EmailProcessor` existente, dos jobs nuevos con su
esquema Zod de payload (un payload inválido lanza `UnrecoverableError`):

| Job | Payload | Asunto | `idempotencyKey` | `jobId` |
|---|---|---|---|---|
| `send-password-reset-email` | `userId, tokenId, email, fullName, token` | `Reset your password` | `password-reset-${tokenId}` | `password-reset-${tokenId}` |
| `send-password-changed-notice` | `userId, tokenId, email, fullName` | `Your password was changed` | `password-changed-${tokenId}` | `password-changed-${tokenId}` |

Todos con `removeOnComplete: true` (el primero lleva el token en claro).
Enlace: `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`.

Plantillas react-email nuevas en `mail/infrastructure/templates/`, en inglés
como las actuales, con puertos renderer propios (`PasswordResetRenderer`,
`PasswordChangedRenderer`):

- **Reset**: saludo, botón, "el enlace caduca en 30 minutos", "si no lo pediste,
  ignora este correo, tu contraseña no cambia".
- **Cambio**: "tu contraseña se cambió el <fecha>; se han cerrado todas las
  sesiones; si no fuiste tú, recupera la cuenta" con enlace a `/forgot-password`.

## 5. Logs

`RUTAS_REDACTADAS` ya cubre `*.password` y `*.token`. El token de reset viaja en
el cuerpo, nunca en la ruta de la API, así que `urlParaRegistro` no cambia. Un
test comprueba que un error en `reset-password` no deja el token ni la
contraseña en el log.

## 6. Frontend

### `/forgot-password` (grupo `RedirectIfAuthenticated`)

- `RecoverPasswordScreen` deja de ser un stub: `apiPost('/auth/forgot-password', { email })`.
- Estado de envío: botón deshabilitado con indicador.
- Éxito (202): la tarjeta sustituye el formulario por un mensaje:
  *"If an account exists for {email}, we've sent a link to reset your password.
  It expires in 30 minutes."*, más "Back to Login". DESIGN-GAP documentado: el
  export de Stitch no dibuja estado de éxito; se compone con las primitivas
  existentes, sin Modal.
- 429: mensaje *"Too many requests. Please try again later."*.
- Otros errores/red: mensaje genérico de reintento.
- El botón "Login" del header y "Back to Login" navegan a `/`.
- El enlace "Forgot password?" del login pasa de `#recover` a `/forgot-password`.

### `/reset-password` (fuera de los guards, como `/verify-email`)

- Pantalla nueva `ResetPasswordScreen`, mismo chrome que recover, compuesta con
  primitivas existentes (Card, Input, Button, FormField, `useValidatedForm`).
- Al montar: lee `token` de la query y lo quita de la URL con
  `history.replaceState` (no queda en el historial ni en capturas). El token se
  guarda en estado del componente. Sin token → estado "invalid link".
- `<meta name="referrer" content="no-referrer">` en `index.html`, para que la URL
  con token nunca salga en un `Referer`.
- Esquema `resetPasswordSchema`: `password` 8..128, `confirmPassword`, refine de
  coincidencia en `confirmPassword` (como el registro).
- Éxito: `navigate('/', { replace: true, state: { passwordReset: true } })`; el
  login muestra *"Your password has been updated. Please log in."*.
- 422 `RESET_TOKEN_INVALID`: estado *"This link is invalid or has expired."*
  con enlace a `/forgot-password`.
- 429 y errores genéricos: mensaje en el formulario, se puede reintentar.
- Si hay una sesión en este navegador, se limpia el `auth-store` tras el éxito:
  el backend ya revocó el refresh.

## 7. Tests (TDD)

Backend:

- `ForgotPasswordUseCase`: cuenta inexistente, verificada y sin verificar
  devuelven `void`. Solo las que existen crean token y encolan. Se caduca el
  token anterior. Correo normalizado. Un fallo del trabajo en segundo plano no
  rechaza la promesa.
- `ResetPasswordUseCase`: el camino feliz actualiza el hash, marca verificado,
  revoca sesiones y encola el aviso. Token inválido, caducado o reutilizado →
  `TokenResetInvalidoError` sin efectos. Un fallo a mitad deshace la unidad de
  trabajo. Un fallo al encolar el aviso no falla el reset.
- Repositorio: fake, Prisma y paridad (CAS concurrente: dos consumos del mismo
  token → solo uno gana).
- `EmailProcessor`: los dos jobs nuevos, payload inválido y URL codificada.
- Plantillas: renderizan enlace, caducidad y texto plano.
- HTTP: 202 idéntico en las tres ramas de `forgot-password`. `reset-password`
  devuelve 200 y 422, 400 de validación para una contraseña de más de 128, y
  el 429 de ambos límites. Después del reset, el login con la contraseña vieja
  falla, el login con la nueva funciona y el refresh viejo se rechaza.

Frontend:

- `RecoverPasswordScreen`: envío, éxito, 429, error de red y enlaces.
- `ResetPasswordScreen`: token retirado de la URL, sin token, validación,
  éxito → login con el aviso, 422 → estado de enlace inválido, 429.
- Router: `/forgot-password` redirige si hay sesión; `/reset-password`
  accesible con y sin sesión.
- `LoginScreen`: aviso de contraseña actualizada y enlace "Forgot password?".
