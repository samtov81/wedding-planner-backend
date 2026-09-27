# Recuperar contraseña — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flujo completo de "olvidé mi contraseña": pedir enlace por correo, fijar contraseña nueva con un token de un solo uso, revocar todas las sesiones y volver al login.

**Architecture:** Backend NestJS con arquitectura hexagonal (`domain/ application/ infrastructure/ interfaces/`): tabla propia `password_reset_tokens` (solo hash SHA-256), dos casos de uso (`ForgotPasswordUseCase`, `ResetPasswordUseCase`), dos endpoints bajo `/auth`, dos correos por la cola BullMQ `email`. Frontend React + react-router: conecta `RecoverPasswordScreen` y añade `ResetPasswordScreen`.

**Tech Stack:** NestJS, Prisma 6 (Postgres), BullMQ, react-email, Zod, Vitest + testcontainers, supertest. Frontend: React 19, react-router 8, zustand, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-22-recuperar-contrasena-design.md` (léela antes de empezar).

## Global Constraints

- Repos: backend `/Users/samueltovar/Documents/GitHub/wedding-planner-backend` (rama `feat/recuperar-contrasena`, ya creada desde `feat/sesion-y-reenvio-verificacion`); frontend `/Users/samueltovar/Documents/GitHub/wedding-planner-frontend` (rama `feat/recuperar-contrasena`, crear desde `feat/sesion-y-router` en la Tarea 8).
- Código, comentarios, nombres de métodos y mensajes de commit en **español**, como el resto del repo. Textos de UI y de correos en **inglés**.
- Commits con el trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Token: `randomBytes(32).toString('base64url')`; se persiste SOLO `hashToken(token)` (de `src/modules/auth/application/token.service.ts`).
- `PASSWORD_RESET_TTL_MINUTES`: entero positivo, defecto **30**.
- Contraseña nueva: **8..128** caracteres. Token en el cuerpo: **1..256** caracteres.
- `POST /auth/forgot-password` → siempre `202 { ok: true }`; límite **3/hora por IP+correo**.
- `POST /auth/reset-password` → `200 { ok: true }`; token inválido/caducado/usado → **422 `RESET_TOKEN_INVALID`**; límite **10/15 min por IP**.
- Jobs en cola `email` con `removeOnComplete: true`: `send-password-reset-email` (jobId/idempotencyKey `password-reset-${tokenId}`, asunto `Reset your password`), `send-password-changed-notice` (jobId/idempotencyKey `password-changed-${tokenId}`, asunto `Your password was changed`).
- Enlace: `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`.
- Regla de dependencias: `application/` no importa Prisma ni `infrastructure/`; los tests de un módulo no importan `infrastructure/` de otro módulo salvo dobles (`*.fake.ts`). `npm run lint:arch` lo comprueba.
- Repositorios Prisma que participan en la unidad de trabajo escriben con `clienteDe(this.prisma)` (`src/modules/database/transaccion.ts`).
- Gates backend al final de cada tarea: `npm run typecheck && npm run lint && npx vitest run <ficheros de la tarea>`. Frontend: `npm run typecheck && npm run lint && npx vitest run <ficheros>`.

## Review Focus

1. **Rotación de refresh concurrente con el reset**: una hija creada por `rotar` en paralelo NO puede sobrevivir a `revocarTodasDeUsuario` → test de 50 vueltas en la Tarea 2.
2. **Dos resets simultáneos con el mismo token**: solo uno gana → test de paridad concurrente en la Tarea 1 y e2e en la Tarea 7.
3. **Token basura o enorme en el cuerpo** (10 000 caracteres, espacios, caracteres no base64url): 400 de validación o 422, nunca 500 → e2e en la Tarea 7.
4. **Recargar / volver atrás en `/reset-password` tras quitar el token de la URL**: el token sobrevive en estado mientras la pantalla está montada; tras recargar se muestra "enlace inválido", no un formulario que falla al enviar → test en la Tarea 9.
5. **Usuario con sesión abierta que usa el enlace**: tras el éxito se limpia el `auth-store` y se llega al login, no al dashboard → test en la Tarea 9.

Aceptado y fuera de alcance (documentado en la spec): access JWT ya emitidos siguen valiendo hasta su TTL; un login con la contraseña vieja que termina en el mismo milisegundo que el reset puede dejar una sesión nueva.

---

## Mapa de ficheros

Backend (`src/modules/…` salvo indicación):

| Fichero | Acción | Responsabilidad |
|---|---|---|
| `prisma/schema.prisma` | Modificar | enum + modelo `PasswordResetToken`, relación en `User` |
| `prisma/migrations/20260922120000_add_password_reset_tokens/migration.sql` | Crear | DDL |
| `config/env.schema.ts` (en `src/config/`) | Modificar | `PASSWORD_RESET_TTL_MINUTES` |
| `auth/domain/password-reset.ts` (+ `.test.ts`) | Crear | generar token, calcular caducidad |
| `auth/domain/auth-errors.ts` | Modificar | `TokenResetInvalidoError` |
| `auth/application/password-reset-token.repository.ts` | Crear | puerto |
| `auth/infrastructure/password-reset-token.repository.fake.ts` | Crear | doble |
| `auth/infrastructure/prisma-password-reset-token.repository.ts` | Crear | adaptador |
| `auth/infrastructure/password-reset-token.repository.paridad.test.ts` | Crear | paridad |
| `users/application/user.repository.ts` + fake + prisma + `user.repository.fake.test.ts` | Modificar | `actualizarPassword` |
| `auth/application/session.repository.ts` + fake + prisma + `prisma-session.repository.test.ts` | Modificar | `revocarTodasDeUsuario` |
| `mail/application/password-reset-renderer.port.ts`, `password-changed-renderer.port.ts` | Crear | puertos |
| `mail/infrastructure/templates/password-reset.tsx`, `password-changed.tsx` (+ tests) | Crear | plantillas |
| `mail/mail.module.ts` | Modificar | proveer/exportar |
| `auth/interfaces/email.processor.ts` (+ test) | Modificar | dos jobs |
| `auth/application/forgot-password.use-case.ts` (+ test) | Crear | caso de uso |
| `auth/application/reset-password.use-case.ts` (+ test) | Crear | caso de uso |
| `auth/interfaces/auth.dto.ts`, `auth.controller.ts`, `auth/auth.module.ts` | Modificar | endpoints y cableado |
| `src/shared/http/limitadores.ts` | Modificar | dos limitadores |
| `test/e2e/auth.e2e.test.ts`, `test/e2e/logging.e2e.test.ts` | Modificar | e2e |

Frontend (`src/…`):

| Fichero | Acción | Responsabilidad |
|---|---|---|
| `features/auth/schemas.ts` (+ test) | Modificar | `resetPasswordSchema` |
| `features/auth/recover-password-screen.tsx` (+ test) | Modificar | llamada a la API, estado de éxito, enlaces |
| `features/auth/reset-password-screen.tsx` (+ test) | Crear | pantalla nueva |
| `app/reset-password-route.tsx` | Crear | lee el token y lo quita de la URL |
| `app/router.tsx` (+ `router.test.tsx`) | Modificar | rutas nuevas |
| `features/auth/login-screen.tsx` (+ test) | Modificar | enlace "Forgot password?" y aviso de éxito |
| `index.html` | Modificar | `<meta name="referrer" content="no-referrer">` |

---

### Task 1: Tabla, puerto y repositorios del token de reset

**Files:**
- Modify: `prisma/schema.prisma`, `src/config/env.schema.ts:150`, `src/modules/auth/domain/auth-errors.ts`
- Create: `prisma/migrations/20260922120000_add_password_reset_tokens/migration.sql`
- Create: `src/modules/auth/domain/password-reset.ts`, `src/modules/auth/domain/password-reset.test.ts`
- Create: `src/modules/auth/application/password-reset-token.repository.ts`
- Create: `src/modules/auth/infrastructure/password-reset-token.repository.fake.ts`
- Create: `src/modules/auth/infrastructure/prisma-password-reset-token.repository.ts`
- Test: `src/modules/auth/infrastructure/password-reset-token.repository.paridad.test.ts`

**Interfaces:**
- Produces:
  - `generarTokenReset(): string`, `caducidadReset(minutos: number, desde?: Date): Date` (en `auth/domain/password-reset.ts`)
  - `class TokenResetInvalidoError extends UnprocessableError` con code `'RESET_TOKEN_INVALID'`
  - `interface PasswordResetTokenRepository { crear(datos: { userId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }>; caducarVigentesDe(userId: string, ahora: Date): Promise<void>; consumirPorHash(tokenHash: string, ahora: Date): Promise<{ userId: string; tokenId: string } | null> }`
  - `PASSWORD_RESET_TOKEN_REPOSITORY` (Symbol)
  - `PasswordResetTokenRepositoryFake`, `PrismaPasswordResetTokenRepository`
  - `Env['PASSWORD_RESET_TTL_MINUTES']: number`

- [ ] **Step 1: Schema Prisma**

En `prisma/schema.prisma`, añade junto a `enum EmailVerificationStatus`:

```prisma
enum PasswordResetStatus {
  PENDING
  CONSUMED
}
```

En `model User`, debajo de `emailVerificationTokens`:

```prisma
  passwordResetTokens         PasswordResetToken[]
```

Después de `model EmailVerificationToken { … }`:

```prisma
/// Tokens de "olvidé mi contraseña". Se guarda el HASH, nunca el token. Un solo
/// uso (PENDING→CONSUMED por compare-and-swap) y vida corta (30 min por defecto).
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

- [ ] **Step 2: Migración generada sin base de datos**

```bash
cd /Users/samueltovar/Documents/GitHub/wedding-planner-backend
mkdir -p prisma/migrations/20260922120000_add_password_reset_tokens
git show HEAD:prisma/schema.prisma > "$TMPDIR/schema-anterior.prisma"
npx prisma migrate diff --from-schema-datamodel "$TMPDIR/schema-anterior.prisma" --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20260922120000_add_password_reset_tokens/migration.sql
cat prisma/migrations/20260922120000_add_password_reset_tokens/migration.sql
npx prisma generate
```

Expected: el SQL contiene `CREATE TYPE "PasswordResetStatus"`, `CREATE TABLE "password_reset_tokens"`, índice único en `tokenHash`, índice en `userId` y FK con `ON DELETE CASCADE`. Nada más (si aparece cualquier otra sentencia, el schema tenía drift: para y avisa).

- [ ] **Step 3: Variable de entorno**

En `src/config/env.schema.ts`, justo después de `EMAIL_VERIFICATION_TTL_HOURS`:

```ts
  /** Minutos de validez de un enlace de recuperación de contraseña (defecto 30). */
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
```

- [ ] **Step 4: Test de dominio (falla)**

`src/modules/auth/domain/password-reset.test.ts`:

```ts
import { caducidadReset, generarTokenReset } from './password-reset'

describe('password-reset (dominio)', () => {
  it('genera 32 bytes aleatorios en base64url, distintos en cada llamada', () => {
    const a = generarTokenReset()
    const b = generarTokenReset()

    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  it('la caducidad se cuenta en minutos desde el instante dado', () => {
    const desde = new Date('2026-09-22T10:00:00.000Z')

    expect(caducidadReset(30, desde)).toEqual(new Date('2026-09-22T10:30:00.000Z'))
  })
})
```

Run: `npx vitest run src/modules/auth/domain/password-reset.test.ts` → FAIL (módulo no existe).

- [ ] **Step 5: Dominio y error**

`src/modules/auth/domain/password-reset.ts`:

```ts
import { randomBytes } from 'node:crypto'

/**
 * Token opaco del enlace de recuperación. 32 bytes: adivinarlo es inviable, así
 * que el límite de ritmo del endpoint es higiene, no la defensa. Se persiste
 * sólo su hash (`hashToken`), nunca este valor.
 */
export function generarTokenReset(): string {
  return randomBytes(32).toString('base64url')
}

export function caducidadReset(minutos: number, desde = new Date()): Date {
  return new Date(desde.getTime() + minutos * 60_000)
}
```

Añade al final de `src/modules/auth/domain/auth-errors.ts` (importa `UnprocessableError` de `@/shared/domain` si el fichero aún no lo hace):

```ts
/**
 * Token de recuperación inexistente, caducado o ya usado: el MISMO error para
 * los tres. Distinguirlos no ayuda al usuario (la salida es la misma: pedir otro
 * enlace) y sí a quien prueba tokens.
 */
export class TokenResetInvalidoError extends UnprocessableError {
  constructor() {
    super('El enlace de recuperación no es válido o ha caducado', 'RESET_TOKEN_INVALID')
  }
}
```

Run: `npx vitest run src/modules/auth/domain/password-reset.test.ts` → PASS.

- [ ] **Step 6: Puerto**

`src/modules/auth/application/password-reset-token.repository.ts`:

```ts
export interface TokenResetConsumido {
  userId: string
  tokenId: string
}

export interface PasswordResetTokenRepository {
  crear(datos: { userId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }>
  /** Caduca (`expiresAt = ahora`) los PENDING vigentes del usuario. */
  caducarVigentesDe(userId: string, ahora: Date): Promise<void>
  /**
   * Compare-and-swap PENDING→CONSUMED si `expiresAt > ahora`. `null` si no
   * existe, ya se usó o caducó: para el llamante son el mismo caso.
   */
  consumirPorHash(tokenHash: string, ahora: Date): Promise<TokenResetConsumido | null>
}

export const PASSWORD_RESET_TOKEN_REPOSITORY = Symbol('PASSWORD_RESET_TOKEN_REPOSITORY')
```

- [ ] **Step 7: Test de paridad (falla)**

`src/modules/auth/infrastructure/password-reset-token.repository.paridad.test.ts`:

```ts
import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { PasswordResetTokenRepository } from '../application/password-reset-token.repository'
import { PasswordResetTokenRepositoryFake } from './password-reset-token.repository.fake'
import { PrismaPasswordResetTokenRepository } from './prisma-password-reset-token.repository'

/**
 * Ruling H1: cada caso se escribe una vez y corre contra el doble y contra
 * Postgres. Se comparan las respuestas del PUERTO: el `tokenId` lo genera cada
 * implementación a su manera, así que se compara contra el `id` que devolvió
 * su propio `crear`.
 */
describe('Paridad: PasswordResetTokenRepositoryFake vs PrismaPasswordResetTokenRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let real: PrismaPasswordResetTokenRepository
  let doble: PasswordResetTokenRepositoryFake
  let userId: string
  let otroUserId: string

  const AHORA = new Date('2026-09-22T10:00:00.000Z')
  const LUEGO = new Date('2026-09-22T10:30:00.000Z')
  const ANTES = new Date('2026-09-22T09:30:00.000Z')

  function implementaciones(): Array<[string, PasswordResetTokenRepository]> {
    return [
      ['Prisma', real],
      ['doble', doble],
    ]
  }

  /** Crea el mismo token en los dos y devuelve el id que dio cada uno. */
  async function sembrarEnAmbos(datos: {
    hash: string
    userId?: string
    expiresAt?: Date
  }): Promise<Map<string, string>> {
    const ids = new Map<string, string>()
    for (const [nombre, repo] of implementaciones()) {
      const { id } = await repo.crear({
        userId: datos.userId ?? userId,
        tokenHash: datos.hash,
        expiresAt: datos.expiresAt ?? LUEGO,
      })
      ids.set(nombre, id)
    }
    return ids
  }

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    real = new PrismaPasswordResetTokenRepository(prisma as unknown as PrismaService)
    userId = (
      await prisma.user.create({ data: { email: 'mio@reset.test', passwordHash: 'x', fullName: 'Mío' } })
    ).id
    otroUserId = (
      await prisma.user.create({ data: { email: 'otro@reset.test', passwordHash: 'x', fullName: 'Otro' } })
    ).id
  }, 240_000)

  beforeEach(async () => {
    await prisma.passwordResetToken.deleteMany()
    doble = new PasswordResetTokenRepositoryFake()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  it('en los dos: un token vigente se consume y devuelve userId y tokenId', async () => {
    const ids = await sembrarEnAmbos({ hash: 'vigente' })

    for (const [nombre, repo] of implementaciones()) {
      expect(await repo.consumirPorHash('vigente', AHORA)).toEqual({ userId, tokenId: ids.get(nombre) })
    }
  })

  it('en los dos: el segundo consumo devuelve null (un solo uso)', async () => {
    await sembrarEnAmbos({ hash: 'dos-veces' })

    for (const [, repo] of implementaciones()) {
      await repo.consumirPorHash('dos-veces', AHORA)
      expect(await repo.consumirPorHash('dos-veces', AHORA)).toBeNull()
    }
  })

  it('en los dos: un hash que nunca existió devuelve null', async () => {
    for (const [, repo] of implementaciones()) {
      expect(await repo.consumirPorHash('nunca', AHORA)).toBeNull()
    }
  })

  it('en los dos: un token caducado devuelve null y sigue PENDING', async () => {
    await sembrarEnAmbos({ hash: 'caducado', expiresAt: ANTES })

    for (const [, repo] of implementaciones()) {
      expect(await repo.consumirPorHash('caducado', AHORA)).toBeNull()
    }
    expect(
      (await prisma.passwordResetToken.findUnique({ where: { tokenHash: 'caducado' } }))?.status,
    ).toBe('PENDING')
  })

  it('en los dos: el borde es exclusivo (expiresAt == ahora ya no vale)', async () => {
    await sembrarEnAmbos({ hash: 'borde', expiresAt: AHORA })

    for (const [, repo] of implementaciones()) {
      expect(await repo.consumirPorHash('borde', AHORA)).toBeNull()
    }
  })

  it('en los dos: caducarVigentesDe invalida los de ese usuario y nada más', async () => {
    await sembrarEnAmbos({ hash: 'mio' })
    await sembrarEnAmbos({ hash: 'ajeno', userId: otroUserId })

    for (const [, repo] of implementaciones()) {
      await repo.caducarVigentesDe(userId, AHORA)
      expect(await repo.consumirPorHash('mio', AHORA)).toBeNull()
      expect(await repo.consumirPorHash('ajeno', AHORA)).not.toBeNull()
    }
  })

  it('en los dos: crear el mismo hash dos veces falla (UNIQUE)', async () => {
    await sembrarEnAmbos({ hash: 'repetido' })

    for (const [, repo] of implementaciones()) {
      await expect(repo.crear({ userId, tokenHash: 'repetido', expiresAt: LUEGO })).rejects.toThrow()
    }
  })

  it('en los dos: dos consumos concurrentes del mismo token, sólo uno gana', async () => {
    await sembrarEnAmbos({ hash: 'carrera' })

    for (const [, repo] of implementaciones()) {
      const resultados = await Promise.all([
        repo.consumirPorHash('carrera', AHORA),
        repo.consumirPorHash('carrera', AHORA),
      ])
      expect(resultados.filter((r) => r !== null)).toHaveLength(1)
    }
  })
})
```

Run: `npx vitest run src/modules/auth/infrastructure/password-reset-token.repository.paridad.test.ts` → FAIL (módulos no existen).

- [ ] **Step 8: Doble**

`src/modules/auth/infrastructure/password-reset-token.repository.fake.ts`:

```ts
import type {
  PasswordResetTokenRepository,
  TokenResetConsumido,
} from '../application/password-reset-token.repository'

interface TokenData {
  id: string
  userId: string
  tokenHash: string
  status: 'PENDING' | 'CONSUMED'
  expiresAt: Date
  consumedAt: Date | null
}

/**
 * Doble en memoria. Su paridad con Prisma la fija
 * `password-reset-token.repository.paridad.test.ts` (ruling H1).
 */
export class PasswordResetTokenRepositoryFake implements PasswordResetTokenRepository {
  private tokens = new Map<string, TokenData>()
  private lastId = 0

  crear(datos: { userId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }> {
    // En Postgres `tokenHash` es UNIQUE: el doble tiene que fallar igual.
    if (this.tokens.has(datos.tokenHash)) {
      return Promise.reject(new Error(`Token hash ya existe: ${datos.tokenHash}`))
    }
    const id = `reset-${++this.lastId}`
    this.tokens.set(datos.tokenHash, { id, ...datos, status: 'PENDING', consumedAt: null })
    return Promise.resolve({ id })
  }

  caducarVigentesDe(userId: string, ahora: Date): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.userId === userId && token.status === 'PENDING' && token.expiresAt > ahora) {
        token.expiresAt = ahora
      }
    }
    return Promise.resolve()
  }

  consumirPorHash(tokenHash: string, ahora: Date): Promise<TokenResetConsumido | null> {
    const token = this.tokens.get(tokenHash)
    // Borde exclusivo, igual que el `expiresAt > ahora` del adaptador Prisma.
    if (token?.status !== 'PENDING' || token.expiresAt.getTime() <= ahora.getTime()) {
      return Promise.resolve(null)
    }
    token.status = 'CONSUMED'
    token.consumedAt = ahora
    return Promise.resolve({ userId: token.userId, tokenId: token.id })
  }

  /** Sólo para tests: cuántos tokens tiene el usuario (de cualquier estado). */
  cantidadDe(userId: string): number {
    return [...this.tokens.values()].filter((t) => t.userId === userId).length
  }
}
```

- [ ] **Step 9: Adaptador Prisma**

`src/modules/auth/infrastructure/prisma-password-reset-token.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe } from '@/modules/database/transaccion'

import type {
  PasswordResetTokenRepository,
  TokenResetConsumido,
} from '../application/password-reset-token.repository'

/**
 * Escribe SIEMPRE con `clienteDe(this.prisma)`: `ResetPasswordUseCase` consume
 * el token dentro de la misma unidad de trabajo que cambia la contraseña y
 * revoca las sesiones (ver el contrato en `UnidadDeTrabajo`).
 */
@Injectable()
export class PrismaPasswordResetTokenRepository implements PasswordResetTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async crear(datos: { userId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }> {
    return await clienteDe(this.prisma).passwordResetToken.create({ data: datos, select: { id: true } })
  }

  async caducarVigentesDe(userId: string, ahora: Date): Promise<void> {
    await clienteDe(this.prisma).passwordResetToken.updateMany({
      where: { userId, status: 'PENDING', expiresAt: { gt: ahora } },
      data: { expiresAt: ahora },
    })
  }

  async consumirPorHash(tokenHash: string, ahora: Date): Promise<TokenResetConsumido | null> {
    const db = clienteDe(this.prisma)
    const fila = await db.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true },
    })
    if (fila === null) return null

    // El CAS es el `updateMany` con el estado y la caducidad en el WHERE: de
    // dos peticiones concurrentes con el mismo token sólo una ve count === 1.
    const { count } = await db.passwordResetToken.updateMany({
      where: { id: fila.id, status: 'PENDING', expiresAt: { gt: ahora } },
      data: { status: 'CONSUMED', consumedAt: ahora },
    })
    return count === 1 ? { userId: fila.userId, tokenId: fila.id } : null
  }
}
```

- [ ] **Step 10: Verificar**

Run: `npx vitest run src/modules/auth/infrastructure/password-reset-token.repository.paridad.test.ts src/modules/auth/domain/password-reset.test.ts src/config && npm run typecheck && npm run lint`
Expected: PASS, sin errores (necesita Docker para testcontainers).

- [ ] **Step 11: Commit**

```bash
git add prisma src/config/env.schema.ts src/modules/auth/domain src/modules/auth/application/password-reset-token.repository.ts src/modules/auth/infrastructure/*password-reset-token*
git commit -m "feat: tabla y repositorio de tokens de recuperación de contraseña

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `actualizarPassword` y `revocarTodasDeUsuario`

**Files:**
- Modify: `src/modules/users/application/user.repository.ts`, `src/modules/users/infrastructure/prisma-user.repository.ts`, `src/modules/users/infrastructure/user.repository.fake.ts`
- Modify: `src/modules/auth/application/session.repository.ts`, `src/modules/auth/infrastructure/prisma-session.repository.ts`, `src/modules/auth/infrastructure/session.repository.fake.ts`
- Test: `src/modules/users/infrastructure/user.repository.fake.test.ts`, `src/modules/auth/infrastructure/prisma-session.repository.test.ts`

**Interfaces:**
- Produces:
  - `UserRepository.actualizarPassword(id: string, passwordHash: string): Promise<void>` — cambia el hash y pone `emailVerifiedAt = now()` SOLO si era null.
  - `SessionRepository.revocarTodasDeUsuario(userId: string): Promise<void>` — revoca todas las sesiones vivas del usuario, serializado con `rotar`.
  - `SessionRepositoryEnMemoria.vivasDeUsuario(userId: string): number` (helper de test)

- [ ] **Step 1: Tests de usuario (fallan)**

Añade al `describe` de `src/modules/users/infrastructure/user.repository.fake.test.ts`:

```ts
  it('actualizarPassword cambia el hash y marca verificado si no lo estaba, en ambas impls', async () => {
    for (const repo of [repoReal, repoFake]) {
      const creado = await repo.create({ email: 'reset@test.com', passwordHash: 'viejo', fullName: 'R' })

      await repo.actualizarPassword(creado.id, 'nuevo')

      const leido = await repo.findByEmail('reset@test.com')
      expect(leido?.passwordHash).toBe('nuevo')
      expect(leido?.emailVerifiedAt).toBeInstanceOf(Date)
    }
  })

  it('actualizarPassword NO reescribe emailVerifiedAt si ya estaba verificado, en ambas impls', async () => {
    for (const repo of [repoReal, repoFake]) {
      const creado = await repo.create({ email: 'yaverif@test.com', passwordHash: 'viejo', fullName: 'V' })
      await repo.marcarEmailVerificado(creado.id)
      const antes = (await repo.findByEmail('yaverif@test.com'))?.emailVerifiedAt

      await new Promise((seguir) => setTimeout(seguir, 5))
      await repo.actualizarPassword(creado.id, 'nuevo')

      expect((await repo.findByEmail('yaverif@test.com'))?.emailVerifiedAt).toEqual(antes)
    }
  })
```

Run: `npx vitest run src/modules/users/infrastructure/user.repository.fake.test.ts` → FAIL (`actualizarPassword` no existe).

- [ ] **Step 2: Implementar en usuarios**

Puerto (`user.repository.ts`), añade a la interfaz:

```ts
  /**
   * Cambia el hash de la contraseña. Marca además el email como verificado si
   * no lo estaba: sólo se llama tras consumir un enlace enviado a ese buzón,
   * que es prueba de control del mismo.
   */
  actualizarPassword(id: string, passwordHash: string): Promise<void>
```

Prisma (`prisma-user.repository.ts`), importa `clienteDe` de `@/modules/database/transaccion` y añade:

```ts
  async actualizarPassword(id: string, passwordHash: string): Promise<void> {
    // `clienteDe`: corre dentro de la unidad de trabajo de ResetPasswordUseCase.
    const db = clienteDe(this.prisma)
    await db.user.update({ where: { id }, data: { passwordHash } })
    // Condicional en el WHERE: no se pisa la fecha de una verificación previa.
    await db.user.updateMany({ where: { id, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } })
  }
```

Fake (`user.repository.fake.ts`):

```ts
  async actualizarPassword(id: string, passwordHash: string): Promise<void> {
    const usuario = this.usuarios.find((u) => u.id === id)
    if (usuario) {
      usuario.passwordHash = passwordHash
      usuario.emailVerifiedAt ??= new Date()
    }
    await Promise.resolve()
  }
```

Run: `npx vitest run src/modules/users/infrastructure/user.repository.fake.test.ts` → PASS.

- [ ] **Step 3: Tests de sesiones (fallan)**

Añade al `describe('PrismaSessionRepository')` de `src/modules/auth/infrastructure/prisma-session.repository.test.ts` (usa `datosNueva`, `crearSesion`, `randomUUID`, `VUELTAS` ya definidos en el fichero):

```ts
  it('revocarTodasDeUsuario revoca todas las familias vivas del usuario y ninguna ajena', async () => {
    const ajeno = await prisma.user.create({
      data: { email: `ajeno-${randomUUID()}@test.com`, passwordHash: 'x', fullName: 'Ajeno' },
    })
    const a = await crearSesion({ familyId: randomUUID() })
    const b = await crearSesion({ familyId: randomUUID() })
    const deOtro = await prisma.session.create({
      data: { ...datosNueva(randomUUID()), userId: ajeno.id },
      select: { id: true },
    })

    await repo.revocarTodasDeUsuario(userId)

    const filas = await prisma.session.findMany({ where: { id: { in: [a.id, b.id, deOtro.id] } } })
    const porId = new Map(filas.map((f) => [f.id, f.revokedAt]))
    expect(porId.get(a.id)).not.toBeNull()
    expect(porId.get(b.id)).not.toBeNull()
    expect(porId.get(deOtro.id)).toBeNull()
  })

  it('revocarTodasDeUsuario no deja viva a la hija de una rotación concurrente', async () => {
    for (let vuelta = 0; vuelta < VUELTAS; vuelta += 1) {
      const familyId = randomUUID()
      const madre = await crearSesion({ familyId })

      await Promise.all([
        repo.rotar({ sesionARevocar: madre.id, nueva: datosNueva(familyId) }),
        repo.revocarTodasDeUsuario(userId),
      ])

      const vivas = await prisma.session.count({ where: { userId, revokedAt: null } })
      expect(vivas).toBe(0)
    }
  })
```

Run: `npx vitest run src/modules/auth/infrastructure/prisma-session.repository.test.ts` → FAIL (`revocarTodasDeUsuario` no existe).

- [ ] **Step 4: Implementar en sesiones**

Puerto (`session.repository.ts`), añade a `SessionRepository`:

```ts
  /**
   * Revoca TODAS las sesiones vivas del usuario (todas sus familias). Tras un
   * cambio de contraseña, cualquier refresh emitido antes deja de servir. Se
   * serializa con `rotar` de cada familia: ninguna hija de una rotación
   * concurrente sobrevive. Participa en la unidad de trabajo si hay una.
   */
  revocarTodasDeUsuario(userId: string): Promise<void>
```

Prisma (`prisma-session.repository.ts`), importa `clienteDe` de `@/modules/database/transaccion` y añade:

```ts
  async revocarTodasDeUsuario(userId: string): Promise<void> {
    const revocar = async (tx: Prisma.TransactionClient): Promise<void> => {
      // Mismo cerrojo que `rotar`, familia a familia y en orden estable (evita
      // interbloqueos entre dos revocaciones concurrentes). Una rotación que
      // tenía el cerrojo al leer esta lista ya aparece aquí porque su sesión
      // madre seguía viva; el `updateMany` de abajo corre tras su COMMIT y ve
      // a la hija.
      const familias = await tx.session.findMany({
        where: { userId, revokedAt: null },
        select: { familyId: true },
        distinct: ['familyId'],
        orderBy: { familyId: 'asc' },
      })
      for (const { familyId } of familias) await this.bloquearFamilia(tx, familyId)

      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    }

    // Dentro de una unidad de trabajo se une a ella; fuera, abre la suya: el
    // cerrojo consultivo sólo existe dentro de una transacción.
    const actual = clienteDe(this.prisma)
    if (actual !== this.prisma) return await revocar(actual)
    await this.prisma.$transaction(revocar)
  }
```

Fake (`session.repository.fake.ts`):

```ts
  revocarTodasDeUsuario(userId: string): Promise<void> {
    const ahora = new Date()
    for (const sesion of this.sesiones) {
      if (sesion.userId === userId && sesion.revokedAt === null) sesion.revokedAt = ahora
    }
    return Promise.resolve()
  }

  /** Helper de test: cuántas sesiones vivas tiene el usuario. */
  vivasDeUsuario(userId: string): number {
    return this.sesiones.filter((s) => s.userId === userId && s.revokedAt === null).length
  }
```

- [ ] **Step 5: Verificar**

Run: `npx vitest run src/modules/auth/infrastructure/prisma-session.repository.test.ts src/modules/users && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/users src/modules/auth/application/session.repository.ts src/modules/auth/infrastructure/*session*
git commit -m "feat: actualizar la contraseña y revocar todas las sesiones de un usuario

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Plantillas de correo

**Files:**
- Create: `src/modules/mail/application/password-reset-renderer.port.ts`, `src/modules/mail/application/password-changed-renderer.port.ts`
- Create: `src/modules/mail/infrastructure/templates/password-reset.tsx`, `password-reset.test.ts`, `password-changed.tsx`, `password-changed.test.ts`
- Modify: `src/modules/mail/mail.module.ts`

**Interfaces:**
- Produces:
  - `PasswordResetRenderer { render(datos: { fullName: string; resetUrl: string; minutosDeValidez: number }): Promise<{ html: string; text: string }> }`, `PASSWORD_RESET_RENDERER`
  - `PasswordChangedRenderer { render(datos: { fullName: string; cambiadoEn: Date; recoverUrl: string }): Promise<{ html: string; text: string }> }`, `PASSWORD_CHANGED_RENDERER`
  - Ambos exportados por `MailModule`.

- [ ] **Step 1: Tests (fallan)**

`src/modules/mail/infrastructure/templates/password-reset.test.ts`:

```ts
import { renderPasswordReset } from './password-reset'

describe('renderPasswordReset', () => {
  const datos = {
    fullName: 'Ana',
    resetUrl: 'https://app.test/reset-password?token=abc123',
    minutosDeValidez: 30,
  }

  it('pone el enlace en el HTML y en el texto plano', async () => {
    const { html, text } = await renderPasswordReset(datos)
    expect(html).toContain('abc123')
    expect(text).toContain('abc123')
  })

  it('el enlace también va como texto visible, no sólo en el botón', async () => {
    const { html } = await renderPasswordReset(datos)
    expect(html.split('abc123').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('dice cuándo caduca y que ignorarlo no cambia nada', async () => {
    const { text } = await renderPasswordReset(datos)
    expect(text).toContain('30 minutes')
    expect(text.toLowerCase()).toContain('ignore')
  })

  it('escapa el nombre en el HTML', async () => {
    const { html } = await renderPasswordReset({ ...datos, fullName: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>')
  })
})
```

`src/modules/mail/infrastructure/templates/password-changed.test.ts`:

```ts
import { renderPasswordChanged } from './password-changed'

describe('renderPasswordChanged', () => {
  const datos = {
    fullName: 'Ana',
    cambiadoEn: new Date('2026-09-22T10:00:00.000Z'),
    recoverUrl: 'https://app.test/forgot-password',
  }

  it('avisa del cambio, con la fecha, y nombra al destinatario', async () => {
    const { text } = await renderPasswordChanged(datos)
    expect(text).toContain('Ana')
    expect(text).toContain('Tue, 22 Sep 2026 10:00:00 GMT')
  })

  it('dice que se cerraron las sesiones y ofrece recuperar la cuenta', async () => {
    const { html, text } = await renderPasswordChanged(datos)
    expect(text.toLowerCase()).toContain('signed out')
    expect(html).toContain('https://app.test/forgot-password')
  })

  it('no lleva ningún token', async () => {
    const { html } = await renderPasswordChanged(datos)
    expect(html).not.toContain('token=')
  })
})
```

Run: `npx vitest run src/modules/mail/infrastructure/templates/password-*.test.ts` → FAIL.

- [ ] **Step 2: Puertos**

`src/modules/mail/application/password-reset-renderer.port.ts`:

```ts
export interface PasswordResetRenderer {
  render(datos: {
    fullName: string
    resetUrl: string
    minutosDeValidez: number
  }): Promise<{ html: string; text: string }>
}

export const PASSWORD_RESET_RENDERER = Symbol('PASSWORD_RESET_RENDERER')
```

`src/modules/mail/application/password-changed-renderer.port.ts`:

```ts
export interface PasswordChangedRenderer {
  render(datos: {
    fullName: string
    cambiadoEn: Date
    recoverUrl: string
  }): Promise<{ html: string; text: string }>
}

export const PASSWORD_CHANGED_RENDERER = Symbol('PASSWORD_CHANGED_RENDERER')
```

- [ ] **Step 3: Plantillas**

`src/modules/mail/infrastructure/templates/password-reset.tsx`:

```tsx
import { Body, Button, Container, Head, Heading, Html, Text } from '@react-email/components'
import { render } from '@react-email/components'

interface Props {
  fullName: string
  resetUrl: string
  minutosDeValidez: number
}

function PasswordReset({ fullName, resetUrl, minutosDeValidez }: Props) {
  return (
    <Html lang="en">
      <Head />
      <Body style={{ fontFamily: 'Georgia, serif', backgroundColor: '#faf7f2' }}>
        <Container style={{ padding: '32px' }}>
          <Heading>Reset your password</Heading>
          <Text>Hi {fullName},</Text>
          <Text>We received a request to reset your password. Click the button below to choose a new one.</Text>
          <Button href={resetUrl} style={{ padding: '12px 24px' }}>
            Reset password
          </Button>
          <Text style={{ fontSize: '12px' }}>If the button does not work, open this link: {resetUrl}</Text>
          <Text style={{ fontSize: '12px', marginTop: '24px', color: '#666' }}>
            This link will expire in {minutosDeValidez} minutes and can only be used once. If you did
            not request a password reset, you can safely ignore this email: your password will not change.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderPasswordReset(datos: Props): Promise<{ html: string; text: string }> {
  const elemento = <PasswordReset {...datos} />
  return {
    html: await render(elemento),
    text: await render(elemento, { plainText: true }),
  }
}
```

`src/modules/mail/infrastructure/templates/password-changed.tsx`:

```tsx
import { Body, Container, Head, Heading, Html, Link, Text } from '@react-email/components'
import { render } from '@react-email/components'

interface Props {
  fullName: string
  cambiadoEn: Date
  recoverUrl: string
}

function PasswordChanged({ fullName, cambiadoEn, recoverUrl }: Props) {
  return (
    <Html lang="en">
      <Head />
      <Body style={{ fontFamily: 'Georgia, serif', backgroundColor: '#faf7f2' }}>
        <Container style={{ padding: '32px' }}>
          <Heading>Your password was changed</Heading>
          <Text>Hi {fullName},</Text>
          {/* UTC explícito: el worker no conoce la zona horaria del destinatario. */}
          <Text>The password for your account was changed on {cambiadoEn.toUTCString()}.</Text>
          <Text>For your security, you have been signed out of all devices.</Text>
          <Text>
            If you did not make this change, recover your account now: <Link href={recoverUrl}>{recoverUrl}</Link>
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderPasswordChanged(datos: Props): Promise<{ html: string; text: string }> {
  const elemento = <PasswordChanged {...datos} />
  return {
    html: await render(elemento),
    text: await render(elemento, { plainText: true }),
  }
}
```

- [ ] **Step 4: Cablear en `MailModule`**

En `src/modules/mail/mail.module.ts` importa los dos puertos y las dos funciones de render, y añade a `providers`:

```ts
    {
      provide: PASSWORD_RESET_RENDERER,
      useValue: { render: renderPasswordReset } satisfies PasswordResetRenderer,
    },
    {
      provide: PASSWORD_CHANGED_RENDERER,
      useValue: { render: renderPasswordChanged } satisfies PasswordChangedRenderer,
    },
```

y a `exports`: `PASSWORD_RESET_RENDERER, PASSWORD_CHANGED_RENDERER`.

- [ ] **Step 5: Verificar**

Run: `npx vitest run src/modules/mail && npm run typecheck && npm run lint` → PASS. Si el texto plano no contiene exactamente `Tue, 22 Sep 2026 10:00:00 GMT` porque react-email parte la línea, ajusta la aserción a comprobar `22 Sep 2026` y `10:00:00`.

- [ ] **Step 6: Commit**

```bash
git add src/modules/mail
git commit -m "feat: plantillas de correo de recuperación y de aviso de cambio de contraseña

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Jobs del `EmailProcessor`

**Files:**
- Modify: `src/modules/auth/interfaces/email.processor.ts`
- Test: `src/modules/auth/interfaces/email.processor.test.ts`

**Interfaces:**
- Consumes: `PasswordResetRenderer`, `PasswordChangedRenderer` (Tarea 3), `Env['PASSWORD_RESET_TTL_MINUTES']` (Tarea 1)
- Produces: el constructor pasa a `(mail, env, plantillaVerificacion, plantillaAviso, plantillaReset, plantillaCambio)`. Payloads:
  - `send-password-reset-email`: `{ userId, tokenId, email, fullName, token }`
  - `send-password-changed-notice`: `{ userId, tokenId, email, fullName }`

- [ ] **Step 1: Tests (fallan)**

En `email.processor.test.ts`:

1. Añade los imports de tipo `PasswordResetRenderer` y `PasswordChangedRenderer` (desde `@/modules/mail/application/...`).
2. Añade dobles locales:

```ts
const plantillaReset: PasswordResetRenderer = {
  render: (datos) =>
    Promise.resolve({
      html: `<a href="${datos.resetUrl}">Reset</a> ${datos.minutosDeValidez}`,
      text: `Reset: ${datos.resetUrl}`,
    }),
}

const plantillaCambio: PasswordChangedRenderer = {
  render: (datos) =>
    Promise.resolve({ html: `<p>Changed ${datos.recoverUrl}</p>`, text: `Changed ${datos.recoverUrl}` }),
}
```

3. Cambia `ENV_DE_PRUEBA` a `{ APP_URL: 'https://app.test', PASSWORD_RESET_TTL_MINUTES: 30 } as Env` y el `beforeEach` a:

```ts
    procesador = new EmailProcessor(
      mail,
      ENV_DE_PRUEBA,
      plantillaVerificacion,
      plantillaAviso,
      plantillaReset,
      plantillaCambio,
    )
```

4. Añade:

```ts
  describe('send-password-reset-email', () => {
    const PAYLOAD = { userId: 'u-1', tokenId: 'r-1', email: 'ana@test.com', fullName: 'Ana', token: 'a+b/c' }

    it('manda el enlace a /reset-password con el token codificado y la caducidad', async () => {
      await procesador.process(jobFalso('send-password-reset-email', PAYLOAD))

      const enviado = mail.enviados[0]
      expect(enviado?.to).toBe('ana@test.com')
      expect(enviado?.subject).toBe('Reset your password')
      expect(enviado?.html).toContain('https://app.test/reset-password?token=a%2Bb%2Fc')
      expect(enviado?.html).toContain('30')
      expect(enviado?.idempotencyKey).toBe('password-reset-r-1')
    })

    it('descarta sin reintentar un payload inválido', async () => {
      await expect(
        procesador.process(jobFalso('send-password-reset-email', { ...PAYLOAD, token: '' })),
      ).rejects.toBeInstanceOf(UnrecoverableError)
      expect(mail.enviados).toHaveLength(0)
    })
  })

  describe('send-password-changed-notice', () => {
    const PAYLOAD = { userId: 'u-1', tokenId: 'r-1', email: 'ana@test.com', fullName: 'Ana' }

    it('manda el aviso con enlace a /forgot-password y clave por token', async () => {
      await procesador.process(jobFalso('send-password-changed-notice', PAYLOAD))

      const enviado = mail.enviados[0]
      expect(enviado?.subject).toBe('Your password was changed')
      expect(enviado?.html).toContain('https://app.test/forgot-password')
      expect(enviado?.idempotencyKey).toBe('password-changed-r-1')
    })

    it('descarta sin reintentar un payload inválido', async () => {
      await expect(
        procesador.process(jobFalso('send-password-changed-notice', { userId: 'u-1' })),
      ).rejects.toBeInstanceOf(UnrecoverableError)
    })
  })
```

Run: `npx vitest run src/modules/auth/interfaces/email.processor.test.ts` → FAIL.

- [ ] **Step 2: Implementar**

En `email.processor.ts`:

```ts
import { PASSWORD_CHANGED_RENDERER, type PasswordChangedRenderer } from '@/modules/mail/application/password-changed-renderer.port'
import { PASSWORD_RESET_RENDERER, type PasswordResetRenderer } from '@/modules/mail/application/password-reset-renderer.port'

const payloadResetSchema = z.object({
  userId: z.string().min(1),
  tokenId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
  token: z.string().min(1),
})

const payloadCambioSchema = z.object({
  userId: z.string().min(1),
  tokenId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
})
```

Constructor, tras `plantillaAviso`:

```ts
    @Inject(PASSWORD_RESET_RENDERER) private readonly plantillaReset: PasswordResetRenderer,
    @Inject(PASSWORD_CHANGED_RENDERER) private readonly plantillaCambio: PasswordChangedRenderer,
```

En `process`, antes del `throw`:

```ts
    if (job.name === 'send-password-reset-email') return await this.enviarReset(job)
    if (job.name === 'send-password-changed-notice') return await this.enviarAvisoCambio(job)
```

Métodos:

```ts
  private async enviarReset(job: Job): Promise<void> {
    const leido = payloadResetSchema.safeParse(job.data)
    if (!leido.success) throw new UnrecoverableError('Payload de recuperación inválido')

    const { email, fullName, token, userId, tokenId } = leido.data
    const { html, text } = await this.plantillaReset.render({
      fullName,
      resetUrl: `${this.env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`,
      minutosDeValidez: this.env.PASSWORD_RESET_TTL_MINUTES,
    })

    await this.mail.send({
      to: email,
      subject: 'Reset your password',
      html,
      text,
      tags: { userId },
      // Por token, igual que la verificación: cada petición nueva sale.
      idempotencyKey: `password-reset-${tokenId}`,
    })
  }

  private async enviarAvisoCambio(job: Job): Promise<void> {
    const leido = payloadCambioSchema.safeParse(job.data)
    if (!leido.success) throw new UnrecoverableError('Payload de aviso de cambio inválido')

    const { email, fullName, userId, tokenId } = leido.data
    const { html, text } = await this.plantillaCambio.render({
      fullName,
      // Momento de envío, no de cambio: la cola lo procesa en segundos.
      cambiadoEn: new Date(),
      recoverUrl: `${this.env.APP_URL}/forgot-password`,
    })

    await this.mail.send({
      to: email,
      subject: 'Your password was changed',
      html,
      text,
      tags: { userId },
      idempotencyKey: `password-changed-${tokenId}`,
    })
  }
```

- [ ] **Step 3: Verificar**

Run: `npx vitest run src/modules/auth/interfaces/email.processor.test.ts && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/auth/interfaces/email.processor.ts src/modules/auth/interfaces/email.processor.test.ts
git commit -m "feat: el worker de correo envía la recuperación y el aviso de cambio

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `ForgotPasswordUseCase`

**Files:**
- Create: `src/modules/auth/application/forgot-password.use-case.ts`
- Test: `src/modules/auth/application/forgot-password.use-case.test.ts`

**Interfaces:**
- Consumes: `UserRepository.findByEmail`, `PasswordResetTokenRepository` (Tarea 1), `QueuePort.enqueue`, `Env['PASSWORD_RESET_TTL_MINUTES']`, `generarTokenReset`, `caducidadReset`, `hashToken`
- Produces: `class ForgotPasswordUseCase { ejecutar(datos: { email: string }): Promise<void> }`, constructor `(usuarios, tokens, cola, env)`

- [ ] **Step 1: Tests (fallan)**

`src/modules/auth/application/forgot-password.use-case.test.ts`:

```ts
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { PasswordResetTokenRepositoryFake } from '../infrastructure/password-reset-token.repository.fake'
import { ForgotPasswordUseCase } from './forgot-password.use-case'
import { hashToken } from './token.service'

/** El trabajo corre sin `await` (ver el docblock del caso de uso). */
const dejarCorrerSegundoPlano = () => new Promise((resolver) => setTimeout(resolver, 0))

function usuario(id: string, email: string, emailVerifiedAt: Date | null) {
  return {
    id,
    email,
    fullName: 'Nombre',
    systemRole: 'USER' as const,
    emailVerifiedAt,
    passwordHash: 'hash:x',
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

describe('ForgotPasswordUseCase', () => {
  let tokens: PasswordResetTokenRepositoryFake
  let cola: InMemoryQueueAdapter
  let caso: ForgotPasswordUseCase

  beforeEach(() => {
    const usuarios = new UserRepositoryEnMemoria([
      usuario('u-verif', 'verificada@test.com', new Date('2026-01-01')),
      usuario('u-pend', 'pendiente@test.com', null),
    ])
    tokens = new PasswordResetTokenRepositoryFake()
    cola = new InMemoryQueueAdapter()
    caso = new ForgotPasswordUseCase(usuarios, tokens, cola, { PASSWORD_RESET_TTL_MINUTES: 30 } as never)
  })

  it('encola el correo con el token en claro para una cuenta verificada', async () => {
    await caso.ejecutar({ email: 'verificada@test.com' })
    await dejarCorrerSegundoPlano()

    expect(cola.encolados).toHaveLength(1)
    const encolado = cola.encolados[0]
    const datos = encolado?.datos as { tokenId: string; token: string; email: string; userId: string }
    expect(encolado?.cola).toBe('email')
    expect(encolado?.nombre).toBe('send-password-reset-email')
    expect(datos.email).toBe('verificada@test.com')
    expect(datos.userId).toBe('u-verif')
    expect(encolado?.jobId).toBe(`password-reset-${datos.tokenId}`)
    expect(encolado?.opciones.removeOnComplete).toBe(true)
    // Lo que se guardó es el hash del token que viaja en el correo.
    expect(await tokens.consumirPorHash(hashToken(datos.token), new Date())).not.toBeNull()
  })

  it('también encola para una cuenta SIN verificar (el reset la verificará)', async () => {
    await caso.ejecutar({ email: 'pendiente@test.com' })
    await dejarCorrerSegundoPlano()

    expect(cola.encolados).toHaveLength(1)
  })

  it('normaliza el correo antes de buscar', async () => {
    await caso.ejecutar({ email: '  Verificada@TEST.com ' })
    await dejarCorrerSegundoPlano()

    expect(cola.encolados).toHaveLength(1)
  })

  it('no encola nada ni lanza si el email no existe', async () => {
    await expect(caso.ejecutar({ email: 'nadie@test.com' })).resolves.toBeUndefined()
    await dejarCorrerSegundoPlano()

    expect(cola.encolados).toHaveLength(0)
  })

  it('un segundo pedido caduca el enlace anterior: sólo uno vivo', async () => {
    await caso.ejecutar({ email: 'verificada@test.com' })
    await dejarCorrerSegundoPlano()
    const primero = (cola.encolados[0]?.datos as { token: string }).token

    await caso.ejecutar({ email: 'verificada@test.com' })
    await dejarCorrerSegundoPlano()

    expect(await tokens.consumirPorHash(hashToken(primero), new Date())).toBeNull()
  })

  it('un fallo del trabajo en segundo plano no rechaza la promesa', async () => {
    vi.spyOn(tokens, 'crear').mockRejectedValue(new Error('BD caída'))

    await expect(caso.ejecutar({ email: 'verificada@test.com' })).resolves.toBeUndefined()
    await dejarCorrerSegundoPlano()

    expect(cola.encolados).toHaveLength(0)
  })
})
```

Run: `npx vitest run src/modules/auth/application/forgot-password.use-case.test.ts` → FAIL.

- [ ] **Step 2: Implementar**

`src/modules/auth/application/forgot-password.use-case.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'
import type { User } from '@/modules/users/domain/user'

import { caducidadReset, generarTokenReset } from '../domain/password-reset'
import {
  PASSWORD_RESET_TOKEN_REPOSITORY,
  type PasswordResetTokenRepository,
} from './password-reset-token.repository'
import { hashToken } from './token.service'

/**
 * "Olvidé mi contraseña". Devuelve `void` SIEMPRE y nunca lanza por el estado
 * de la cuenta: inexistente, verificada y sin verificar son indistinguibles
 * desde fuera, igual que en `ResendVerificationUseCase` (ver su docblock).
 *
 * El trabajo (caducar el enlace anterior, crear el nuevo, encolar el correo)
 * corre SIN `await`: si la respuesta esperase a esas tres escrituras sólo
 * cuando la cuenta existe, cronometrarla diría quién tiene cuenta. El `.catch`
 * es obligatorio: una promesa rechazada sin manejador tumba el proceso.
 *
 * Las cuentas sin verificar también reciben el enlace: usarlo prueba el
 * control del buzón y `ResetPasswordUseCase` las marca verificadas.
 */
@Injectable()
export class ForgotPasswordUseCase {
  private readonly logger = new Logger(ForgotPasswordUseCase.name)

  constructor(
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    @Inject(PASSWORD_RESET_TOKEN_REPOSITORY) private readonly tokens: PasswordResetTokenRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async ejecutar(datos: { email: string }): Promise<void> {
    const usuario = await this.usuarios.findByEmail(datos.email.trim().toLowerCase())
    if (usuario === null) return

    // A propósito SIN `await`: ver el docblock de la clase.
    void this.emitirEnlace(usuario).catch((error: unknown) => {
      this.logger.error('Fallo al emitir el enlace de recuperación de contraseña', error as Error)
    })
  }

  private async emitirEnlace(usuario: Pick<User, 'id' | 'email' | 'fullName'>): Promise<void> {
    const ahora = new Date()
    // Un solo enlace vivo: un correo viejo filtrado deja de servir.
    await this.tokens.caducarVigentesDe(usuario.id, ahora)

    const tokenEnClaro = generarTokenReset()
    const { id: tokenId } = await this.tokens.crear({
      userId: usuario.id,
      tokenHash: hashToken(tokenEnClaro),
      expiresAt: caducidadReset(this.env.PASSWORD_RESET_TTL_MINUTES, ahora),
    })

    await this.cola.enqueue(
      'email',
      'send-password-reset-email',
      { userId: usuario.id, tokenId, email: usuario.email, fullName: usuario.fullName, token: tokenEnClaro },
      // removeOnComplete obligatorio: el payload lleva el token en claro.
      { jobId: `password-reset-${tokenId}`, removeOnComplete: true },
    )
  }
}
```

- [ ] **Step 3: Verificar**

Run: `npx vitest run src/modules/auth/application/forgot-password.use-case.test.ts && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/auth/application/forgot-password.use-case*
git commit -m "feat: caso de uso de solicitud de recuperación de contraseña

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `ResetPasswordUseCase`

**Files:**
- Create: `src/modules/auth/application/reset-password.use-case.ts`
- Test: `src/modules/auth/application/reset-password.use-case.test.ts`

**Interfaces:**
- Consumes: `PasswordResetTokenRepository` (T1), `UserRepository.actualizarPassword`/`findById` (T2), `SessionRepository.revocarTodasDeUsuario` (T2), `PasswordHasher.hash`, `UnidadDeTrabajo`, `QueuePort`, `TokenResetInvalidoError` (T1)
- Produces: `class ResetPasswordUseCase { ejecutar(datos: { token: string; password: string }): Promise<void> }`, constructor `(tokens, usuarios, sesiones, hasher, uow, cola)`

- [ ] **Step 1: Tests (fallan)**

`src/modules/auth/application/reset-password.use-case.test.ts`:

```ts
import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import type { PasswordHasher } from '@/modules/users/application/password-hasher.port'
import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { TokenResetInvalidoError } from '../domain/auth-errors'
import { PasswordResetTokenRepositoryFake } from '../infrastructure/password-reset-token.repository.fake'
import { SessionRepositoryEnMemoria } from '../infrastructure/session.repository.fake'
import { ResetPasswordUseCase } from './reset-password.use-case'
import { hashToken } from './token.service'

/** Hash de mentira: `hash:<plano>`, como en login.use-case.test.ts. */
const hasher: PasswordHasher = {
  hash: (plano) => Promise.resolve(`hash:${plano}`),
  verify: (hash, plano) => Promise.resolve(hash === `hash:${plano}`),
}

const AHORA = Date.now()

describe('ResetPasswordUseCase', () => {
  let tokens: PasswordResetTokenRepositoryFake
  let usuarios: UserRepositoryEnMemoria
  let sesiones: SessionRepositoryEnMemoria
  let uow: UnidadDeTrabajoEnMemoria
  let cola: InMemoryQueueAdapter
  let caso: ResetPasswordUseCase

  beforeEach(async () => {
    usuarios = new UserRepositoryEnMemoria([
      {
        id: 'u-1',
        email: 'ana@test.com',
        fullName: 'Ana',
        systemRole: 'USER',
        emailVerifiedAt: null,
        passwordHash: 'hash:vieja',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    tokens = new PasswordResetTokenRepositoryFake()
    sesiones = new SessionRepositoryEnMemoria()
    uow = new UnidadDeTrabajoEnMemoria()
    cola = new InMemoryQueueAdapter()
    caso = new ResetPasswordUseCase(tokens, usuarios, sesiones, hasher, uow, cola)

    await tokens.crear({ userId: 'u-1', tokenHash: hashToken('bueno'), expiresAt: new Date(AHORA + 600_000) })
    await tokens.crear({ userId: 'u-1', tokenHash: hashToken('caducado'), expiresAt: new Date(AHORA - 1) })
    for (const familyId of ['f-1', 'f-2']) {
      await sesiones.crear({ userId: 'u-1', tokenHash: `s-${familyId}`, familyId, expiresAt: new Date(AHORA + 86_400_000) })
    }
  })

  it('cambia la contraseña, marca verificado, revoca sesiones y encola el aviso', async () => {
    await caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })

    const usuario = await usuarios.findByEmail('ana@test.com')
    expect(usuario?.passwordHash).toBe('hash:una-nueva-larga')
    expect(usuario?.emailVerifiedAt).toBeInstanceOf(Date)
    expect(sesiones.vivasDeUsuario('u-1')).toBe(0)
    expect(uow.transacciones).toBe(1)

    expect(cola.encolados).toHaveLength(1)
    const aviso = cola.encolados[0]
    expect(aviso?.nombre).toBe('send-password-changed-notice')
    expect(aviso?.datos).toEqual({ userId: 'u-1', tokenId: 'reset-1', email: 'ana@test.com', fullName: 'Ana' })
    expect(aviso?.jobId).toBe('password-changed-reset-1')
  })

  it('el mismo token no sirve dos veces', async () => {
    await caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })

    await expect(caso.ejecutar({ token: 'bueno', password: 'otra-mas-larga' })).rejects.toBeInstanceOf(
      TokenResetInvalidoError,
    )
    expect((await usuarios.findByEmail('ana@test.com'))?.passwordHash).toBe('hash:una-nueva-larga')
  })

  it.each([['caducado'], ['inexistente']])('token %s → TokenResetInvalidoError sin efectos', async (token) => {
    await expect(caso.ejecutar({ token, password: 'una-nueva-larga' })).rejects.toBeInstanceOf(
      TokenResetInvalidoError,
    )

    expect((await usuarios.findByEmail('ana@test.com'))?.passwordHash).toBe('hash:vieja')
    expect(sesiones.vivasDeUsuario('u-1')).toBe(2)
    expect(cola.encolados).toHaveLength(0)
  })

  it('las escrituras corren dentro de la unidad de trabajo', async () => {
    const dentro: boolean[] = []
    const original = sesiones.revocarTodasDeUsuario.bind(sesiones)
    vi.spyOn(sesiones, 'revocarTodasDeUsuario').mockImplementation(async (id) => {
      dentro.push(uow.activa)
      await original(id)
    })

    await caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })

    expect(dentro).toEqual([true])
  })

  it('un fallo dentro de la transacción se propaga y no encola el aviso', async () => {
    vi.spyOn(sesiones, 'revocarTodasDeUsuario').mockRejectedValue(new Error('BD caída'))

    await expect(caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })).rejects.toThrow('BD caída')
    expect(cola.encolados).toHaveLength(0)
  })

  it('si falla encolar el aviso, el reset sigue contando como hecho', async () => {
    vi.spyOn(cola, 'enqueue').mockRejectedValue(new Error('Redis caído'))

    await expect(caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })).resolves.toBeUndefined()
    expect((await usuarios.findByEmail('ana@test.com'))?.passwordHash).toBe('hash:una-nueva-larga')
  })

  it('caduca cualquier otro enlace vivo del usuario', async () => {
    await tokens.crear({ userId: 'u-1', tokenHash: hashToken('otro'), expiresAt: new Date(AHORA + 600_000) })

    await caso.ejecutar({ token: 'bueno', password: 'una-nueva-larga' })

    expect(await tokens.consumirPorHash(hashToken('otro'), new Date())).toBeNull()
  })
})
```

Run: `npx vitest run src/modules/auth/application/reset-password.use-case.test.ts` → FAIL.

- [ ] **Step 2: Implementar**

`src/modules/auth/application/reset-password.use-case.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import { PASSWORD_HASHER, type PasswordHasher } from '@/modules/users/application/password-hasher.port'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'

import { TokenResetInvalidoError } from '../domain/auth-errors'
import {
  PASSWORD_RESET_TOKEN_REPOSITORY,
  type PasswordResetTokenRepository,
} from './password-reset-token.repository'
import { SESSION_REPOSITORY, type SessionRepository } from './session.repository'
import { hashToken } from './token.service'

/**
 * Fija la contraseña nueva a partir de un enlace de recuperación.
 *
 * Consumir el token, cambiar el hash, marcar el email verificado, revocar
 * TODAS las sesiones y caducar los demás enlaces van en UNA unidad de trabajo:
 * a medias, quedaría o un token gastado sin contraseña nueva, o una contraseña
 * nueva con las sesiones del atacante vivas.
 *
 * El Argon2 va ANTES y fuera de la transacción: son decenas de milisegundos de
 * CPU que no deben retener una conexión de la base de datos. Si el token luego
 * resulta inválido, ese trabajo se tira; es el precio de no bloquear el pool.
 *
 * No crea sesión: el enlace del correo nunca equivale a un login.
 */
@Injectable()
export class ResetPasswordUseCase {
  private readonly logger = new Logger(ResetPasswordUseCase.name)

  constructor(
    @Inject(PASSWORD_RESET_TOKEN_REPOSITORY) private readonly tokens: PasswordResetTokenRepository,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    @Inject(SESSION_REPOSITORY) private readonly sesiones: SessionRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(UNIDAD_DE_TRABAJO) private readonly uow: UnidadDeTrabajo,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(datos: { token: string; password: string }): Promise<void> {
    const passwordHash = await this.hasher.hash(datos.password)

    const consumido = await this.uow.ejecutar(async () => {
      const ahora = new Date()
      const token = await this.tokens.consumirPorHash(hashToken(datos.token), ahora)
      if (token === null) throw new TokenResetInvalidoError()

      await this.usuarios.actualizarPassword(token.userId, passwordHash)
      await this.sesiones.revocarTodasDeUsuario(token.userId)
      await this.tokens.caducarVigentesDe(token.userId, ahora)
      return token
    })

    await this.avisarDelCambio(consumido.userId, consumido.tokenId)
  }

  /**
   * Fuera de la transacción y sin propagar el error: la contraseña YA cambió;
   * contestar 500 haría que el usuario reintentase con un token ya gastado.
   */
  private async avisarDelCambio(userId: string, tokenId: string): Promise<void> {
    try {
      const usuario = await this.usuarios.findById(userId)
      if (usuario === null) return
      await this.cola.enqueue(
        'email',
        'send-password-changed-notice',
        { userId, tokenId, email: usuario.email, fullName: usuario.fullName },
        { jobId: `password-changed-${tokenId}`, removeOnComplete: true },
      )
    } catch (error) {
      this.logger.error('Fallo al encolar el aviso de cambio de contraseña', error as Error)
    }
  }
}
```

- [ ] **Step 3: Verificar**

Run: `npx vitest run src/modules/auth/application/reset-password.use-case.test.ts && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/auth/application/reset-password.use-case*
git commit -m "feat: caso de uso de restablecimiento de contraseña

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Endpoints, limitadores, cableado y e2e

**Files:**
- Modify: `src/shared/http/limitadores.ts`, `src/modules/auth/interfaces/auth.dto.ts`, `src/modules/auth/interfaces/auth.controller.ts`, `src/modules/auth/auth.module.ts`
- Test: `test/e2e/auth.e2e.test.ts`, `test/e2e/logging.e2e.test.ts`

**Interfaces:**
- Consumes: `ForgotPasswordUseCase` (T5), `ResetPasswordUseCase` (T6), `PrismaPasswordResetTokenRepository`, `PASSWORD_RESET_TOKEN_REPOSITORY` (T1)
- Produces: `POST /auth/forgot-password`, `POST /auth/reset-password` (contrato en Global Constraints)

- [ ] **Step 1: Tests e2e (fallan)**

En `test/e2e/auth.e2e.test.ts`, añade dentro del `describe('Auth e2e')`, junto a `tokenDelEnlace`:

```ts
  /** Espera al correo con ESE asunto: los tests comparten el adaptador y los destinatarios reciben varios. */
  async function esperarCorreoCon(destinatario: string, asunto: string): Promise<{ html: string }> {
    for (let intento = 0; intento < 100; intento += 1) {
      const mensaje = correo.enviados.find((m) => m.to === destinatario && m.subject === asunto)
      if (mensaje !== undefined) return { html: mensaje.html ?? '' }
      await new Promise((seguir) => setTimeout(seguir, 100))
    }
    throw new Error(`No llegó "${asunto}" a ${destinatario} en 10s`)
  }

  function tokenDeReset(html: string): string {
    const encontrado = /reset-password\?token=([A-Za-z0-9_%-]+)/.exec(html)
    if (encontrado?.[1] === undefined) throw new Error('El correo no trae enlace de recuperación')
    return decodeURIComponent(encontrado[1])
  }

  /** Registra y verifica una cuenta; devuelve la cookie de una sesión abierta. */
  async function cuentaConSesion(email: string, password: string): Promise<string> {
    await request(url).post('/auth/register').send({ email, password, fullName: 'Reset' }).expect(201)
    const { html } = await esperarCorreoA(email)
    await request(url).post('/auth/verify-email').send({ token: tokenDelEnlace(html) }).expect(200)
    const login = await request(url).post('/auth/login').send({ email, password }).expect(200)
    const cookie = primeraCookie(login)
    if (cookie === undefined) throw new Error('Sin cookie de refresh')
    return cookie
  }
```

y el bloque:

```ts
  describe('recuperación de contraseña', () => {
    it('ciclo completo: pedir enlace, fijar contraseña, sesiones cerradas y aviso', async () => {
      const cookieVieja = await cuentaConSesion('reset@test.com', 'contraseña-vieja-1')

      await request(url).post('/auth/forgot-password').send({ email: 'reset@test.com' }).expect(202)
      const { html } = await esperarCorreoCon('reset@test.com', 'Reset your password')

      await request(url)
        .post('/auth/reset-password')
        .send({ token: tokenDeReset(html), password: 'contraseña-nueva-1' })
        .expect(200, { ok: true })

      await request(url).post('/auth/login').send({ email: 'reset@test.com', password: 'contraseña-vieja-1' }).expect(401)
      await request(url).post('/auth/login').send({ email: 'reset@test.com', password: 'contraseña-nueva-1' }).expect(200)
      await request(url).post('/auth/refresh').set('Cookie', cookieVieja).expect(401)
      await esperarCorreoCon('reset@test.com', 'Your password was changed')
    })

    it('el mismo enlace no sirve dos veces: 422 RESET_TOKEN_INVALID', async () => {
      await cuentaConSesion('reset-dos@test.com', 'contraseña-vieja-1')
      await request(url).post('/auth/forgot-password').send({ email: 'reset-dos@test.com' }).expect(202)
      const token = tokenDeReset((await esperarCorreoCon('reset-dos@test.com', 'Reset your password')).html)

      const [a, b] = await Promise.all([
        request(url).post('/auth/reset-password').send({ token, password: 'nueva-contraseña-a' }),
        request(url).post('/auth/reset-password').send({ token, password: 'nueva-contraseña-b' }),
      ])

      expect([a.status, b.status].sort()).toEqual([200, 422])
      const perdedora = a.status === 422 ? a : b
      expect((perdedora.body as CuerpoError).code).toBe('RESET_TOKEN_INVALID')
    })

    it('una cuenta sin verificar puede restablecer y queda verificada', async () => {
      await request(url)
        .post('/auth/register')
        .send({ email: 'sinverif-reset@test.com', password: 'contraseña-vieja-1', fullName: 'SV' })
        .expect(201)
      await request(url).post('/auth/forgot-password').send({ email: 'sinverif-reset@test.com' }).expect(202)
      const { html } = await esperarCorreoCon('sinverif-reset@test.com', 'Reset your password')

      await request(url)
        .post('/auth/reset-password')
        .send({ token: tokenDeReset(html), password: 'contraseña-nueva-1' })
        .expect(200)

      await request(url)
        .post('/auth/login')
        .send({ email: 'sinverif-reset@test.com', password: 'contraseña-nueva-1' })
        .expect(200)
    })

    it('forgot-password responde lo MISMO exista la cuenta o no', async () => {
      await cuentaConSesion('existe-reset@test.com', 'contraseña-vieja-1')

      const existe = await request(url).post('/auth/forgot-password').send({ email: 'existe-reset@test.com' })
      const noExiste = await request(url).post('/auth/forgot-password').send({ email: 'nadie-reset@test.com' })

      expect(existe.status).toBe(202)
      expect(noExiste.status).toBe(202)
      expect(noExiste.body).toEqual(existe.body)
    })

    it('forgot-password con email mal formado da 400', async () => {
      await request(url).post('/auth/forgot-password').send({ email: 'no-es-email' }).expect(400)
    })

    it('reset-password: token falso 422; contraseña corta, larga o token enorme 400; nunca 500', async () => {
      await request(url).post('/auth/reset-password').send({ token: 'no-existe', password: 'contraseña-larga' }).expect(422)
      await request(url).post('/auth/reset-password').send({ token: 'x', password: 'corta' }).expect(400)
      await request(url).post('/auth/reset-password').send({ token: 'x', password: 'a'.repeat(129) }).expect(400)
      await request(url).post('/auth/reset-password').send({ token: 'a'.repeat(10_000), password: 'contraseña-larga' }).expect(400)
      await request(url).post('/auth/reset-password').send({ token: ' ¿?%00 ', password: 'contraseña-larga' }).expect(422)
    })

    it('el cuarto forgot-password en una hora contra el mismo IP+correo da 429', async () => {
      const pedir = () => request(url).post('/auth/forgot-password').send({ email: 'limite-forgot@test.com' })
      for (let i = 0; i < 3; i += 1) await pedir().expect(202)

      expect((await pedir()).status).toBe(429)
    })

    it('el undécimo reset-password en 15 minutos desde la misma IP da 429', async () => {
      const pedir = () => request(url).post('/auth/reset-password').send({ token: 'falso', password: 'contraseña-larga' })
      for (let i = 0; i < 10; i += 1) await pedir().expect(422)

      expect((await pedir()).status).toBe(429)
    })
  })
```

En `test/e2e/logging.e2e.test.ts`, añade:

```ts
  it('ni el token de recuperación ni la contraseña nueva llegan al log', async () => {
    await request(url)
      .post('/auth/reset-password')
      .send({ token: 'token-secreto-de-reset', password: 'contraseña-secreta-nueva' })
      .expect(422)

    const todo = logs.todo()
    expect(todo).toContain('/auth/reset-password')
    expect(todo).not.toContain('token-secreto-de-reset')
    expect(todo).not.toContain('contraseña-secreta-nueva')
  })
```

Run: `npx vitest run test/e2e/auth.e2e.test.ts test/e2e/logging.e2e.test.ts` → FAIL (404 en las rutas nuevas).

- [ ] **Step 2: Limitadores**

En `src/shared/http/limitadores.ts`:

```ts
export const LIMITADOR_FORGOT_PASSWORD = 'forgot-password'
export const LIMITADOR_RESET_PASSWORD = 'reset-password'
```

Añade `| typeof LIMITADOR_FORGOT_PASSWORD | typeof LIMITADOR_RESET_PASSWORD` a `LimitadorDeRuta`, y al array de `crearLimitadores`:

```ts
    {
      name: LIMITADOR_FORGOT_PASSWORD,
      ttl: 3_600_000,
      limit: 3,
      skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_FORGOT_PASSWORD),
    },
    {
      name: LIMITADOR_RESET_PASSWORD,
      ttl: 900_000,
      limit: 10,
      skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_RESET_PASSWORD),
    },
```

- [ ] **Step 3: DTOs**

Al final de `src/modules/auth/interfaces/auth.dto.ts`:

```ts
export const forgotPasswordSchema = z.object({
  email: z.email(),
})
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>

export const resetPasswordSchema = z.object({
  /** Un token real mide 43; el tope sólo corta basura antes de hashearla. */
  token: z.string().min(1).max(256),
  /** Mismo mínimo que el registro. El máximo acota el trabajo de Argon2. */
  password: z.string().min(8).max(128),
})
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>
```

- [ ] **Step 4: Controlador**

En `auth.controller.ts`: importa `LIMITADOR_FORGOT_PASSWORD`, `LIMITADOR_RESET_PASSWORD`, `ForgotPasswordUseCase`, `ResetPasswordUseCase`, `forgotPasswordSchema`, `resetPasswordSchema`; inyecta los dos casos de uso en el constructor (`private readonly forgotPasswordUseCase: ForgotPasswordUseCase`, `private readonly resetPasswordUseCase: ResetPasswordUseCase`) y añade, antes de `me`:

```ts
  /**
   * Pedir el enlace de recuperación. 202 y el mismo cuerpo SIEMPRE, exista la
   * cuenta o no: cualquier diferencia enumeraría cuentas. 3 por hora por
   * IP+correo: sin límite es un cañón de correo contra cualquier dirección.
   */
  @Post('forgot-password')
  @HttpCode(202)
  @LimiteDeRuta(LIMITADOR_FORGOT_PASSWORD, { limit: 3, ttl: 3_600_000, getTracker: rastreoPorIpYCorreo })
  async forgotPassword(@Body() body: unknown): Promise<{ ok: true }> {
    const datos = validarCon(forgotPasswordSchema, body)
    await this.forgotPasswordUseCase.ejecutar(datos)
    return { ok: true }
  }

  /**
   * Fijar la contraseña nueva con el token del correo. No abre sesión ni toca
   * la cookie: el usuario vuelve al login. 10 cada 15 min por IP: el token de
   * 32 bytes ya hace inviable adivinarlo; el límite es higiene.
   */
  @Post('reset-password')
  @HttpCode(200)
  @LimiteDeRuta(LIMITADOR_RESET_PASSWORD, { limit: 10, ttl: 900_000 })
  async resetPassword(@Body() body: unknown): Promise<{ ok: true }> {
    const datos = validarCon(resetPasswordSchema, body)
    await this.resetPasswordUseCase.ejecutar(datos)
    return { ok: true }
  }
```

- [ ] **Step 5: Módulo**

En `src/modules/auth/auth.module.ts`, importa lo necesario y añade a `providers`:

```ts
    {
      provide: PASSWORD_RESET_TOKEN_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaPasswordResetTokenRepository(prisma),
      inject: [PrismaService],
    },
    ForgotPasswordUseCase,
    ResetPasswordUseCase,
```

`PASSWORD_HASHER` lo exporta `UsersModule` (ya lo usa `LoginUseCase`) y `UNIDAD_DE_TRABAJO` viene del `DatabaseModule` global.

- [ ] **Step 6: Verificar todo el backend**

Run: `npx vitest run test/e2e/auth.e2e.test.ts test/e2e/logging.e2e.test.ts` → PASS.
Run: `npm run typecheck && npm run lint && npm test` → todo PASS. Si algún test existente construye `AuthController` o `EmailProcessor` a mano y falla por los parámetros nuevos, añade los argumentos que faltan en ese test.

- [ ] **Step 7: Commit**

```bash
git add src test
git commit -m "feat: endpoints de recuperación y restablecimiento de contraseña

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8 (frontend): `/forgot-password` conectado a la API

Trabaja en `/Users/samueltovar/Documents/GitHub/wedding-planner-frontend`.

**Files:**
- Modify: `src/features/auth/recover-password-screen.tsx`, `src/features/auth/recover-password-screen.test.tsx`
- Modify: `src/app/router.tsx`, `src/app/router.test.tsx`
- Modify: `src/features/auth/login-screen.tsx:266` (enlace "Forgot password?"), `src/features/auth/login-screen.test.tsx`

**Interfaces:**
- Consumes: `apiPost`, `ApiRequestError` de `src/lib/api-client.ts`; `POST /auth/forgot-password` → 202 `{ ok: true }`
- Produces: ruta `/forgot-password` dentro del grupo `RedirectIfAuthenticated`

- [ ] **Step 1: Rama**

```bash
cd /Users/samueltovar/Documents/GitHub/wedding-planner-frontend
git switch feat/sesion-y-router && git switch -c feat/recuperar-contrasena
```

(El `.superpowers/sdd-followups/token-expiry-report.md` sin trackear se queda como está; no lo añadas.)

- [ ] **Step 2: Tests (fallan)**

En `recover-password-screen.test.tsx`:

1. Añade el mock y el helper de montaje con router (el componente pasa a usar `<Link>`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { ApiRequestError } from '../../lib/api-client'

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }))
vi.mock('../../lib/api-client', async (importarReal) => ({
  ...(await importarReal<typeof import('../../lib/api-client')>()),
  apiPost,
}))

function montar() {
  return render(
    <MemoryRouter>
      <RecoverPasswordScreen />
    </MemoryRouter>,
  )
}

beforeEach(() => apiPost.mockReset())
afterEach(() => vi.restoreAllMocks())
```

2. Sustituye todos los `render(<RecoverPasswordScreen />)` por `montar()`.
3. Cambia el test del CTA: `within(banner()).getByRole('link', { name: 'Login' })` y comprueba `toHaveAttribute('href', '/')`.
4. Cambia "devuelve al login": `expect(screen.getByRole('link', { name: 'Back to Login' })).toHaveAttribute('href', '/')`.
5. Añade:

```ts
describe('RecoverPasswordScreen — envío', () => {
  it('pide el enlace al backend con el email normalizado', async () => {
    apiPost.mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    montar()
    await user.type(email(), '  ana@example.com ')
    await user.click(submit())

    expect(apiPost).toHaveBeenCalledWith('/auth/forgot-password', { email: 'ana@example.com' })
  })

  it('tras el 202 sustituye el formulario por un mensaje que no revela si la cuenta existe', async () => {
    apiPost.mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    montar()
    await user.type(email(), 'ana@example.com')
    await user.click(submit())

    const estado = await screen.findByRole('status')
    expect(estado).toHaveTextContent('If an account exists for ana@example.com')
    expect(estado).toHaveTextContent('30 minutes')
    expect(estado.textContent?.toLowerCase()).not.toMatch(/not found|no account|doesn.t exist/)
    expect(screen.queryByRole('button', { name: 'Send Reset Link' })).not.toBeInTheDocument()
  })

  it('deshabilita el botón mientras envía', async () => {
    apiPost.mockImplementation(() => new Promise(() => undefined))
    const user = userEvent.setup()
    montar()
    await user.type(email(), 'ana@example.com')
    await user.click(submit())

    expect(screen.getByRole('button', { name: /Sending/ })).toBeDisabled()
  })

  it('un 429 dice que espere y deja reintentar', async () => {
    apiPost.mockRejectedValue(new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'x' }))
    const user = userEvent.setup()
    montar()
    await user.type(email(), 'ana@example.com')
    await user.click(submit())

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests. Please try again later.')
    expect(submit()).toBeEnabled()
  })

  it('un error de red muestra un mensaje genérico', async () => {
    apiPost.mockRejectedValue(new TypeError('Failed to fetch'))
    const user = userEvent.setup()
    montar()
    await user.type(email(), 'ana@example.com')
    await user.click(submit())

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.')
  })
})
```

En `login-screen.test.tsx`, añade (usa el helper de montaje que ya tenga el fichero):

```ts
  it('"Forgot password?" lleva a /forgot-password', () => {
    // monta la pantalla como hacen los demás tests del fichero
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password')
  })
```

En `router.test.tsx`, añade a `RUTAS` dentro del grupo `RedirectIfAuthenticated` `{ path: '/forgot-password', element: <RecoverPasswordScreen /> }` (importándolo) y:

```ts
  it('/forgot-password sin sesión pinta la recuperación', () => {
    montar('/forgot-password')
    expect(screen.getByRole('heading', { level: 1, name: 'Reset Password' })).toBeInTheDocument()
  })

  it('/forgot-password con sesión redirige al dashboard', () => {
    useAuthStore.setState(SESION)
    montar('/forgot-password')
    expect(screen.queryByRole('heading', { level: 1, name: 'Reset Password' })).not.toBeInTheDocument()
  })
```

Run: `npx vitest run src/features/auth/recover-password-screen.test.tsx src/features/auth/login-screen.test.tsx src/app/router.test.tsx` → FAIL.

- [ ] **Step 3: Implementar la pantalla**

En `recover-password-screen.tsx`:

1. Importa `useState` de `react`, `Link` de `react-router`, `apiPost` y `ApiRequestError` de `../../lib/api-client`.
2. Sustituye el DESIGN-GAP de "no hay estado de éxito" del docblock por:

```
 * DESIGN-GAP: el export no dibuja el estado de éxito. Se compone dentro de la
 * misma tarjeta con texto y el enlace de vuelta, sin Modal ni primitivas
 * nuevas. El mensaje es deliberadamente condicional ("If an account
 * exists…"): el backend responde 202 igual exista o no la cuenta, y la
 * pantalla no puede saber más que él.
```

3. Borra `const handleRecover = () => {}` y, dentro del componente:

```tsx
  const [enviando, setEnviando] = useState(false)
  const [enviadoA, setEnviadoA] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleRecover = ({ email }: { email: string }) => {
    // `useValidatedForm` no espera promesas: la parte async va en una IIFE.
    void (async () => {
      setEnviando(true)
      setError(null)
      try {
        await apiPost('/auth/forgot-password', { email })
        setEnviadoA(email)
      } catch (err) {
        setError(
          err instanceof ApiRequestError && err.status === 429
            ? 'Too many requests. Please try again later.'
            : 'Something went wrong. Please try again.',
        )
      } finally {
        setEnviando(false)
      }
    })()
  }

  const form = useValidatedForm(recoverPasswordSchema, { email: '' }, handleRecover)
```

4. El CTA del header:

```tsx
        actions={
          <Button variant="primary" size="sm" asChild>
            <Link to="/">Login</Link>
          </Button>
        }
```

5. Dentro de `<Card padding="xl">`, envuelve el `<form>` así:

```tsx
            {enviadoA === null ? (
              <form className="space-y-6" onSubmit={form.handleSubmit} noValidate>
                {/* …FormField existente sin cambios… */}

                {error === null ? null : (
                  <p role="alert" className="text-sm text-danger-strong">
                    {error}
                  </p>
                )}

                <Button
                  type="submit"
                  variant="inverse"
                  size="lg"
                  className="w-full"
                  disabled={enviando}
                  iconTrailing={<ArrowRightIcon />}
                >
                  {enviando ? 'Sending…' : 'Send Reset Link'}
                </Button>
              </form>
            ) : (
              <p role="status" className="text-center text-base text-ink/70">
                If an account exists for {enviadoA}, we&apos;ve sent a link to reset your password. It
                expires in 30 minutes.
              </p>
            )}
```

6. "Back to Login":

```tsx
                <Button variant="link" size="sm" asChild iconLeading={<ArrowLeftIcon />}>
                  <Link to="/">Back to Login</Link>
                </Button>
```

- [ ] **Step 4: Ruta y enlace del login**

`src/app/router.tsx`: importa `RecoverPasswordScreen` y añade al grupo `RedirectIfAuthenticated`:

```tsx
      { path: '/forgot-password', element: <RecoverPasswordScreen /> },
```

`src/features/auth/login-screen.tsx:266`: sustituye `<a href="#recover">Forgot password?</a>` por `<Link to="/forgot-password">Forgot password?</Link>` (`Link` ya está importado).

- [ ] **Step 5: Verificar**

Run: `npx vitest run src/features/auth src/app && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "feat: la pantalla de recuperación pide el enlace al backend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9 (frontend): `/reset-password` y aviso en el login

**Files:**
- Modify: `src/features/auth/schemas.ts`, `src/features/auth/schemas.test.ts`
- Create: `src/features/auth/reset-password-screen.tsx`, `src/features/auth/reset-password-screen.test.tsx`
- Create: `src/app/reset-password-route.tsx`
- Modify: `src/app/router.tsx`, `src/app/router.test.tsx`, `src/features/auth/login-screen.tsx`, `src/features/auth/login-screen.test.tsx`, `index.html`

**Interfaces:**
- Consumes: `POST /auth/reset-password` → 200 / 422 `RESET_TOKEN_INVALID` / 429; `useAuthStore.getState().clear()`
- Produces: `resetPasswordSchema`, `ResetPasswordValues`; `ResetPasswordScreen({ token }: { token: string | null })`; `ResetPasswordRoute`; `location.state.passwordReset === true` en `/`

- [ ] **Step 1: Esquema (test falla)**

En `schemas.test.ts` añade:

```ts
describe('resetPasswordSchema', () => {
  it('acepta 8..128 caracteres que coinciden', () => {
    expect(resetPasswordSchema.safeParse({ password: 'a'.repeat(8), confirmPassword: 'a'.repeat(8) }).success).toBe(true)
    expect(resetPasswordSchema.safeParse({ password: 'a'.repeat(128), confirmPassword: 'a'.repeat(128) }).success).toBe(true)
  })

  it('rechaza menos de 8 y más de 128', () => {
    expect(resetPasswordSchema.safeParse({ password: 'a'.repeat(7), confirmPassword: 'a'.repeat(7) }).success).toBe(false)
    expect(resetPasswordSchema.safeParse({ password: 'a'.repeat(129), confirmPassword: 'a'.repeat(129) }).success).toBe(false)
  })

  it('cuelga el desajuste de confirmPassword', () => {
    const r = resetPasswordSchema.safeParse({ password: 'abcdefgh', confirmPassword: 'abcdefgX' })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.path).toEqual(['confirmPassword'])
  })
})
```

(importa `resetPasswordSchema`). En `schemas.ts`:

```ts
/**
 * Contraseña nueva. Mismo mínimo que el registro; el máximo es el del backend
 * (acota el trabajo de Argon2): validarlo aquí evita un 400 opaco.
 */
export const resetPasswordSchema = z
  .object({
    password: z.string().min(8, 'Use at least 8 characters.').max(128, 'Use at most 128 characters.'),
    confirmPassword: z.string().min(1, 'Confirm your new password.'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  })
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>
```

Run: `npx vitest run src/features/auth/schemas.test.ts` → PASS.

- [ ] **Step 2: Tests de la pantalla (fallan)**

`src/features/auth/reset-password-screen.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { ApiRequestError } from '../../lib/api-client'
import { useAuthStore } from '../../lib/auth-store'
import { ResetPasswordScreen } from './reset-password-screen'

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }))
vi.mock('../../lib/api-client', async (importarReal) => ({
  ...(await importarReal<typeof import('../../lib/api-client')>()),
  apiPost,
}))

/** Con un `/` que pinta el `state` recibido, para comprobar la navegación. */
function montar(token: string | null) {
  const router = createMemoryRouter(
    [
      { path: '/reset-password', element: <ResetPasswordScreen token={token} /> },
      {
        path: '/',
        Component: function Destino() {
          return <p>login {JSON.stringify(router.state.location.state)}</p>
        },
      },
      { path: '/forgot-password', element: <p>forgot</p> },
    ],
    { initialEntries: ['/reset-password'] },
  )
  render(<RouterProvider router={router} />)
  return router
}

const nueva = () => screen.getByLabelText('New password')
const confirmar = () => screen.getByLabelText('Confirm new password')
const enviar = () => screen.getByRole('button', { name: 'Update Password' })

beforeEach(() => {
  apiPost.mockReset()
  useAuthStore.setState({ status: 'anonymous', accessToken: null, user: null })
})
afterEach(() => vi.restoreAllMocks())

describe('ResetPasswordScreen', () => {
  it('sin token muestra el enlace inválido y ofrece pedir otro', () => {
    montar(null)
    expect(screen.getByRole('heading', { level: 1, name: 'Link invalid or expired' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password')
  })

  it('valida longitud y coincidencia antes de llamar al backend', async () => {
    const user = userEvent.setup()
    montar('tok')
    await user.type(nueva(), 'corta')
    await user.type(confirmar(), 'otra')
    await user.click(enviar())

    expect(screen.getByText('Use at least 8 characters.')).toBeInTheDocument()
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('con éxito manda token y contraseña y lleva al login con el aviso', async () => {
    apiPost.mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    montar('tok')
    await user.type(nueva(), 'una-nueva-larga')
    await user.type(confirmar(), 'una-nueva-larga')
    await user.click(enviar())

    expect(apiPost).toHaveBeenCalledWith('/auth/reset-password', { token: 'tok', password: 'una-nueva-larga' })
    expect(await screen.findByText(/login .*"passwordReset":true/)).toBeInTheDocument()
  })

  it('con una sesión abierta en este navegador, la limpia tras el éxito', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      accessToken: 'viejo',
      user: { id: 'u-1', email: 'a@b.c', fullName: 'Ana', systemRole: 'USER' },
    })
    apiPost.mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    montar('tok')
    await user.type(nueva(), 'una-nueva-larga')
    await user.type(confirmar(), 'una-nueva-larga')
    await user.click(enviar())

    await screen.findByText(/login/)
    expect(useAuthStore.getState().status).toBe('anonymous')
  })

  it('un 422 RESET_TOKEN_INVALID pasa al estado de enlace inválido', async () => {
    apiPost.mockRejectedValue(new ApiRequestError(422, { code: 'RESET_TOKEN_INVALID', message: 'x' }))
    const user = userEvent.setup()
    montar('tok')
    await user.type(nueva(), 'una-nueva-larga')
    await user.type(confirmar(), 'una-nueva-larga')
    await user.click(enviar())

    expect(await screen.findByRole('heading', { level: 1, name: 'Link invalid or expired' })).toBeInTheDocument()
  })

  it('un 429 deja el formulario y avisa', async () => {
    apiPost.mockRejectedValue(new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'x' }))
    const user = userEvent.setup()
    montar('tok')
    await user.type(nueva(), 'una-nueva-larga')
    await user.type(confirmar(), 'una-nueva-larga')
    await user.click(enviar())

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again later.')
    expect(enviar()).toBeEnabled()
  })
})
```

Test de la ruta — añade a `router.test.tsx` (importa `ResetPasswordRoute` y añade `{ path: '/reset-password', element: <ResetPasswordRoute /> }` a `RUTAS` fuera de los grupos). Como `montar` no devuelve el router, crea uno local:

```tsx
  it('/reset-password quita el token de la URL pero lo conserva para el formulario', async () => {
    const router = createMemoryRouter(RUTAS, { initialEntries: ['/reset-password?token=abc'] })
    render(<RouterProvider router={router} />)

    await vi.waitFor(() => expect(router.state.location.search).toBe(''))
    expect(screen.getByLabelText('New password')).toBeInTheDocument()
  })

  it('/reset-password sin token (p. ej. tras recargar) muestra el enlace inválido', () => {
    montar('/reset-password')
    expect(screen.getByRole('heading', { level: 1, name: 'Link invalid or expired' })).toBeInTheDocument()
  })

  it('/reset-password es accesible con sesión', () => {
    useAuthStore.setState(SESION)
    montar('/reset-password?token=abc')
    expect(screen.getByLabelText('New password')).toBeInTheDocument()
  })
```

Aviso en el login — añade a `login-screen.test.tsx`, montando con `MemoryRouter initialEntries={[{ pathname: '/', state: { passwordReset: true } }]}` (adapta al helper del fichero):

```tsx
  it('tras restablecer la contraseña avisa de que ya puede entrar', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/', state: { passwordReset: true } }]}>
        <LoginScreen />
      </MemoryRouter>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Your password has been updated. Please log in.')
  })
```

Run: `npx vitest run src/features/auth src/app` → FAIL.

- [ ] **Step 3: Pantalla**

`src/features/auth/reset-password-screen.tsx`:

```tsx
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { PageChrome, type PageChromeNavItem } from '../../components/layout/page-chrome'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Divider } from '../../components/ui/divider'
import { FormField } from '../../components/ui/form-field'
import { Input } from '../../components/ui/input'
import { apiPost, ApiRequestError } from '../../lib/api-client'
import { useAuthStore } from '../../lib/auth-store'
import { useValidatedForm } from '../../lib/use-validated-form'
import { ArrowLeftIcon, ArrowRightIcon, WaveIcon } from './auth-icons'
import { resetPasswordSchema, type ResetPasswordValues } from './schemas'

/**
 * ResetPasswordScreen — destino del enlace del correo de recuperación
 * (`/reset-password?token=…`). Sin export de diseño: mismo chrome y tarjeta que
 * `recover-password-screen.tsx`, compuesto con primitivas existentes.
 *
 * El token llega por prop: `ResetPasswordRoute` lo lee y lo quita de la URL.
 *
 * Tras el éxito NO hay sesión nueva (el backend revoca todas y no emite
 * ninguna): se limpia la local y se va al login con un aviso.
 */

const NAV: PageChromeNavItem[] = [
  { id: 'features', label: 'Features', href: '#features' },
  { id: 'gallery', label: 'Gallery', href: '#gallery' },
  { id: 'pricing', label: 'Pricing', href: '#pricing' },
]

export function ResetPasswordScreen({ token }: { token: string | null }) {
  const navigate = useNavigate()
  const [invalido, setInvalido] = useState(token === null || token === '')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleReset = ({ password }: ResetPasswordValues) => {
    void (async () => {
      setEnviando(true)
      setError(null)
      try {
        await apiPost('/auth/reset-password', { token, password })
        // El backend ya revocó el refresh: una sesión local sería un fantasma.
        useAuthStore.getState().clear()
        await navigate('/', { replace: true, state: { passwordReset: true } })
      } catch (err) {
        if (err instanceof ApiRequestError && err.body.code === 'RESET_TOKEN_INVALID') {
          setInvalido(true)
          return
        }
        setError(
          err instanceof ApiRequestError && err.status === 429
            ? 'Too many attempts. Try again later.'
            : 'Something went wrong. Please try again.',
        )
      } finally {
        setEnviando(false)
      }
    })()
  }

  const form = useValidatedForm(resetPasswordSchema, { password: '', confirmPassword: '' }, handleReset)

  return (
    <div className="flex min-h-screen w-full flex-col bg-surface">
      <PageChrome
        layout="two-group-trailing"
        items={NAV}
        brand={
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-primary">
              <WaveIcon />
            </span>
            <h2 className="text-xl font-bold tracking-tight text-ink">WeddingSaaS</h2>
          </div>
        }
        actions={
          <Button variant="primary" size="sm" asChild>
            <Link to="/">Login</Link>
          </Button>
        }
      />

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md space-y-8">
          {invalido ? (
            <div className="space-y-4 text-center">
              <h1 className="text-4xl font-bold tracking-tight text-ink">Link invalid or expired</h1>
              <p className="text-base text-ink/70">
                Reset links expire after 30 minutes and can only be used once.
              </p>
              <Button variant="primary" size="lg" asChild>
                <Link to="/forgot-password">Request a new link</Link>
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-2 text-center">
                <h1 className="text-4xl font-bold tracking-tight text-ink">Choose a New Password</h1>
                <p className="text-base text-ink/70">You will be signed out of all devices.</p>
              </div>

              <Card padding="xl">
                <form className="space-y-6" onSubmit={form.handleSubmit} noValidate>
                  <FormField id="reset-password" label="New password" error={form.errors.password} alert={form.submitted}>
                    {(control) => (
                      <Input
                        {...control}
                        {...form.fieldProps('password')}
                        name="password"
                        type="password"
                        autoComplete="new-password"
                      />
                    )}
                  </FormField>

                  <FormField
                    id="reset-confirm"
                    label="Confirm new password"
                    error={form.errors.confirmPassword}
                    alert={form.submitted}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        {...form.fieldProps('confirmPassword')}
                        name="confirmPassword"
                        type="password"
                        autoComplete="new-password"
                      />
                    )}
                  </FormField>

                  {error === null ? null : (
                    <p role="alert" className="text-sm text-danger-strong">
                      {error}
                    </p>
                  )}

                  <Button
                    type="submit"
                    variant="inverse"
                    size="lg"
                    className="w-full"
                    disabled={enviando}
                    iconTrailing={<ArrowRightIcon />}
                  >
                    Update Password
                  </Button>
                </form>

                <div className="mt-8 space-y-6">
                  <Divider />
                  <div className="text-center">
                    <Button variant="link" size="sm" asChild iconLeading={<ArrowLeftIcon />}>
                      <Link to="/">Back to Login</Link>
                    </Button>
                  </div>
                </div>
              </Card>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
```

Nota: si `form.fieldProps` exige que el nombre exista en el tipo del esquema, `'password'` y `'confirmPassword'` ya lo cumplen. Mientras envía, el nombre del botón sigue siendo "Update Password" (el test del 429 lo busca por nombre).

- [ ] **Step 4: Ruta**

`src/app/reset-password-route.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ResetPasswordScreen } from '../features/auth/reset-password-screen'

/**
 * Lee el token UNA vez y lo quita de la URL (`replace`): así no queda en el
 * historial, ni en una captura de pantalla, ni en el `Referer` de un recurso
 * que la página cargue (el `<meta name="referrer">` de `index.html` es la
 * segunda barrera). El `useState` con inicializador conserva el token aunque
 * la URL ya no lo lleve; tras recargar, no hay token y la pantalla lo dice.
 */
export function ResetPasswordRoute() {
  const [params, setParams] = useSearchParams()
  const [token] = useState(() => params.get('token'))

  useEffect(() => {
    if (params.has('token')) setParams({}, { replace: true })
  }, [params, setParams])

  return <ResetPasswordScreen token={token} />
}
```

`src/app/router.tsx`: importa `ResetPasswordRoute` y añade, junto a `/verify-email` (fuera de los guards):

```tsx
  { path: '/reset-password', element: <ResetPasswordRoute /> },
```

Amplía el comentario de encima del router: `/reset-password` también queda fuera de los guards, por la misma razón que `/verify-email`.

- [ ] **Step 5: Aviso en el login y referrer**

En `login-screen.tsx`, dentro del componente (tras `const location = useLocation()`):

```tsx
  // Viene de `ResetPasswordScreen`. Leer un booleano de `location.state` es
  // inocuo: como mucho, alguien se fabrica a sí mismo el aviso.
  const vieneDeReset = (location.state as { passwordReset?: unknown } | null)?.passwordReset === true
```

y justo antes del `<form>`:

```tsx
        {vieneDeReset ? (
          <p role="status" className="text-center text-sm text-ink/70">
            Your password has been updated. Please log in.
          </p>
        ) : null}
```

En `index.html`, dentro de `<head>`, tras el viewport:

```html
    <!-- El token de /reset-password viaja en la query: nunca debe salir en un Referer. -->
    <meta name="referrer" content="no-referrer" />
```

- [ ] **Step 6: Verificar**

Run: `npx vitest run && npm run typecheck && npm run lint` → todo PASS.

- [ ] **Step 7: Commit**

```bash
git add src index.html
git commit -m "feat: pantalla para fijar la contraseña nueva y aviso en el login

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Verificación final

- Backend: `npm run typecheck && npm run lint && npm test` en verde.
- Frontend: `npm run typecheck && npm run lint && npm test` en verde.
- Prueba manual opcional con los dos servidores levantados (`MAIL_DRIVER=fake`): el enlace del correo aparece en el log del adaptador fake.
