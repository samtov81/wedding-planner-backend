# Backend — núcleo + vertical de invitados/RSVP · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Levantar el backend de wedding-planner con su núcleo de plataforma (auth, eventos, autorización, colas, correo, tiempo real) y un dominio vertical completo de invitados/RSVP que lo atraviesa de punta a punta.

**Architecture:** NestJS con Clean Architecture **por módulo** (`domain/` → `application/` → `infrastructure/` + `interfaces/`), con la regla de dependencia impuesta por `dependency-cruiser` en CI en vez de por convención. Persistencia en PostgreSQL vía Prisma; Redis sostiene colas (BullMQ), rate limiting y el adapter de Socket.IO. Todo servicio externo entra por un puerto declarado en `application/` con adaptador en `infrastructure/`, de modo que los casos de uso se prueban sin IO.

**Tech Stack:** Node 22 LTS · TypeScript 5.x estricto · NestJS 11 · Prisma 6 · PostgreSQL 16 · Redis 7 · BullMQ · Socket.IO 4 · Resend + React Email · Zod 4 + `nestjs-zod` · Argon2id · Vitest 3 + Testcontainers + supertest · pino

**Spec:** `docs/superpowers/specs/2026-09-17-backend-nucleo-invitados-design.md`

## Global Constraints

Estas reglas aplican a **todas** las tareas. No se repiten en cada una.

- **Regla de dependencia:** `domain/` no importa nada externo — ni Prisma, ni NestJS, ni Zod. `application/` importa sólo `domain/`. `infrastructure/` e `interfaces/` importan hacia dentro, nunca al revés. Un módulo no importa el `infrastructure/` de otro módulo.
- **TypeScript estricto agresivo:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`. `arr[0]` es `T | undefined`.
- **Idioma:** `describe` y nombres de test **en español**; comentarios y docblocks **en español**; identificadores, rutas y strings de API **en inglés**. Mismo criterio que el frontend.
- **`faker` no se instala.** La 6.6.6 está comprometida. Donde haga falta variación, PRNG determinista (mulberry32).
- **Toda entrada validada con Zod** en el `ValidationPipe` global. El borde no conoce `any`.
- **`$queryRawUnsafe` prohibido** — regla de ESLint, no acuerdo verbal.
- **Los agregados se derivan**, nunca se persisten como columna de contador.
- **Sin acceso al evento ⇒ `404`**, no `403`. `403` sólo para quien tiene acceso al evento pero no permiso para esa operación.
- **Prettier:** sin punto y coma, comillas simples, ancho 100 — igual que el frontend. Los `.md` van en `.prettierignore`.
- **Commits en español**, en imperativo, con prefijo convencional (`feat:`, `test:`, `chore:`, `docs:`).

## Estructura de ficheros

```
src/
  main.ts                                arranque, helmet, CORS, pipes y filtros globales
  app.module.ts                          composición raíz
  config/
    env.schema.ts                        esquema Zod del entorno
    env.ts                               loadEnv(): valida y lanza al arrancar
    config.module.ts
  shared/
    domain/domain-error.ts               jerarquía de errores de dominio
    domain/cursor.ts                     codificación de cursor de paginación
    http/domain-exception.filter.ts      DomainError → HTTP, sin filtrar internals
    http/request-id.middleware.ts        requestId propagado a logs y jobs
    logging/logger.ts                    pino con redacción de campos sensibles
    testing/                             builders y dobles compartidos
  modules/
    database/prisma.service.ts
    queue/                               QueuePort + adaptador BullMQ
    mail/                                MailPort + adaptadores fake y Resend
    realtime/                            RealtimePort + gateway Socket.IO
    users/                               entidad User, repositorio, hashing
    auth/                                registro, login, refresh rotativo, guards
    events/                              Event, EventMembership, EventAccessService
    vendors/                             VendorProfile, EventVendor
    guests/                              vertical completo: CRUD, invitaciones, RSVP
    notifications/                       Notification persistida + emisión
    health/                              liveness y readiness
  prisma/schema.prisma
test/
  e2e/                                   supertest sobre la app completa
  support/containers.ts                  Postgres y Redis con Testcontainers
```

**Por qué esta forma:** los ficheros que cambian juntos viven juntos. Un cambio en cómo se invita a un invitado toca `modules/guests/` y nada más; no obliga a navegar cuatro árboles de nivel raíz. Cada módulo expone su puerto público y esconde su `infrastructure/`.

---

### Task 1: Esqueleto del proyecto y entorno validado que falla al arrancar

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.prettierrc`, `.prettierignore`, `.gitignore`, `.env.example`
- Create: `src/config/env.schema.ts`, `src/config/env.ts`, `src/config/config.module.ts`
- Test: `src/config/env.test.ts`

**Interfaces:**
- Consumes: nada, es la primera tarea.
- Produces: `envSchema`, `type Env`, `loadEnv(source: NodeJS.ProcessEnv): Env`, `class EnvValidationError extends Error`, y `ConfigModule` que provee `Env` bajo el token `ENV`.

**Por qué esto es la Tarea 1:** un backend que arranca con `JWT_ACCESS_SECRET` vacío no falla al arrancar — falla seis horas después, en producción, cuando alguien intenta iniciar sesión. Validar el entorno *antes* de construir nada convierte una clase entera de incidentes en un error de arranque legible.

- [ ] **Step 1: Inicializar el proyecto y las dependencias**

```bash
npm init -y
npm i @nestjs/common@^11 @nestjs/core@^11 @nestjs/platform-express@^11 reflect-metadata rxjs zod@^4
npm i -D typescript@^5 @types/node vitest@^3 unplugin-swc @swc/core prettier
```

- [ ] **Step 2: Configurar TypeScript en estricto agresivo**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./",
    "baseUrl": "./",
    "paths": { "@/*": ["src/*"] },
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 3: Configurar Vitest**

NestJS usa decoradores con metadatos en tiempo de ejecución, que esbuild (el transformador por defecto de Vite) **no** emite. `unplugin-swc` sí, y es el camino soportado para correr Nest bajo Vitest.

`vitest.config.ts`:

```ts
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
    alias: { '@': new URL('./src/', import.meta.url).pathname },
  },
})
```

Y en `package.json`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write ."
  }
}
```

- [ ] **Step 4: Escribir el test que falla**

`src/config/env.test.ts`:

```ts
import { EnvValidationError, loadEnv } from './env'

const valido: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/wp',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  APP_URL: 'http://localhost:5173',
}

describe('loadEnv', () => {
  it('devuelve un entorno tipado cuando todo está presente', () => {
    const env = loadEnv(valido)

    expect(env.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/wp')
    expect(env.PORT).toBe(3000)
    expect(env.MAIL_DRIVER).toBe('fake')
  })

  it('lanza nombrando LA variable que falta, no un error genérico', () => {
    const { JWT_ACCESS_SECRET: _omitida, ...sinSecreto } = valido

    expect(() => loadEnv(sinSecreto)).toThrow(EnvValidationError)
    expect(() => loadEnv(sinSecreto)).toThrow(/JWT_ACCESS_SECRET/)
  })

  it('rechaza un secreto demasiado corto para firmar', () => {
    expect(() => loadEnv({ ...valido, JWT_ACCESS_SECRET: 'corto' })).toThrow(/JWT_ACCESS_SECRET/)
  })

  it('acumula TODAS las variables inválidas en un solo mensaje', () => {
    const roto = { ...valido, DATABASE_URL: 'no-es-una-url', REDIS_URL: 'tampoco' }

    expect(() => loadEnv(roto)).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/)
  })
})
```

El cuarto test no es adorno: quien arranca con tres variables mal no quiere descubrirlas de una en una, reiniciando tres veces.

- [ ] **Step 5: Ejecutar el test y verificar que falla**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL — `Failed to resolve import "./env"`.

- [ ] **Step 6: Escribir el esquema del entorno**

`src/config/env.schema.ts`:

```ts
import { z } from 'zod'

/**
 * Entorno del backend. Cada variable se valida al arrancar: un secreto ausente
 * tiene que romper el arranque, no la primera petición que lo necesite.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  /** 32 bytes es el mínimo razonable para HS256; por debajo el secreto es el eslabón débil. */
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /** `fake` escribe los correos a disco; en producción el arranque exige `resend`. */
  MAIL_DRIVER: z.enum(['fake', 'resend']).default('fake'),
  MAIL_FROM: z.email().default('no-reply@weddingplanner.test'),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),

  /** Origen del frontend: base de los enlaces de RSVP y allowlist de CORS. */
  APP_URL: z.url(),
  CORS_ORIGINS: z.string().default(''),
})

export type Env = z.infer<typeof envSchema>
```

- [ ] **Step 7: Escribir el cargador que falla en voz alta**

`src/config/env.ts`:

```ts
import { envSchema, type Env } from './env.schema'

export class EnvValidationError extends Error {
  constructor(detalle: string) {
    super(`Configuración de entorno inválida:\n${detalle}`)
    this.name = 'EnvValidationError'
  }
}

/**
 * Valida el entorno y devuelve un objeto tipado. Acumula TODOS los fallos en un
 * único mensaje: reiniciar tres veces para descubrir tres variables mal es
 * exactamente lo que esta función existe para evitar.
 */
export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const resultado = envSchema.safeParse(source)

  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new EnvValidationError(detalle)
  }

  return resultado.data
}
```

- [ ] **Step 8: Ejecutar los tests y verificar que pasan**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 9: Exponer el entorno como módulo global de Nest**

`src/config/config.module.ts`:

```ts
import { Global, Module } from '@nestjs/common'

import { loadEnv } from './env'
import type { Env } from './env.schema'

/** Token de inyección del entorno. Nadie lee `process.env` fuera de aquí. */
export const ENV = Symbol('ENV')

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv(process.env) }],
  exports: [ENV],
})
export class ConfigModule {}
```

**Regla que este módulo impone:** `process.env` se lee en **un solo sitio**. Un `process.env.ALGO` esparcido por el código es una variable que nadie validó y que no aparece en `.env.example`.

- [ ] **Step 10: Escribir `.env.example` y los ignores**

`.env.example`:

```bash
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://wp:wp@localhost:5432/wedding_planner
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=cambia-esto-por-32-caracteres-o-mas
JWT_ACCESS_TTL=15m
REFRESH_TTL_DAYS=30
MAIL_DRIVER=fake
MAIL_FROM=no-reply@weddingplanner.test
APP_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173
```

`.gitignore`: `node_modules/`, `dist/`, `.env`, `coverage/`, `.mail-outbox/`
`.prettierignore`: `dist/`, `coverage/`, `*.md`, `prisma/migrations/`

- [ ] **Step 11: Commit**

```bash
git add .
git commit -m "feat: esqueleto del proyecto y entorno validado al arrancar

El entorno se valida con Zod en un unico punto y acumula todos los fallos
en un mensaje: un secreto ausente rompe el arranque en vez de la primera
peticion que lo necesita."
```

---

### Task 2: El gate arquitectónico — dependency-cruiser y ESLint

**Files:**
- Create: `.dependency-cruiser.cjs`, `eslint.config.js`
- Modify: `package.json` (scripts `lint`, `lint:arch`)
- Test: `test/architecture/dependency-rules.test.ts`

**Interfaces:**
- Consumes: la estructura `src/modules/<dominio>/{domain,application,infrastructure,interfaces}` de la Tarea 1.
- Produces: `npm run lint` como gate ejecutable; ninguna API de código.

**Por qué va tan pronto:** la regla de dependencia es el corazón del diseño, y una regla arquitectónica que sólo vive en la cabeza de quien revisa se rompe en tres semanas. El frontend de este mismo producto no confía en que nadie recuerde su regla de tokens: la comprueba con `scripts/dead-tokens.mjs`. Aquí igual. Ponerla ahora significa que **ninguna** tarea posterior puede violarla sin que CI lo diga.

- [ ] **Step 1: Instalar las herramientas**

```bash
npm i -D dependency-cruiser eslint typescript-eslint @eslint/js eslint-plugin-security
```

- [ ] **Step 2: Escribir el test que falla**

`test/architecture/dependency-rules.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Verifica el GATE, no el código: escribe una violación deliberada en un
 * directorio temporal dentro de `src/` y comprueba que dependency-cruiser la
 * caza. Un gate que nunca se ha visto fallar no se sabe si funciona.
 */
describe('regla de dependencia', () => {
  const violacion = join(process.cwd(), 'src/modules/__probe__')

  afterEach(() => rmSync(violacion, { recursive: true, force: true }))

  function correrCruiser(): { code: number; salida: string } {
    try {
      const salida = execFileSync('npx', ['depcruise', 'src', '--config', '.dependency-cruiser.cjs'], {
        encoding: 'utf8',
      })
      return { code: 0, salida }
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string }
      return { code: e.status, salida: `${e.stdout}${e.stderr}` }
    }
  }

  it('acepta el código actual', () => {
    expect(correrCruiser().code).toBe(0)
  })

  it('rechaza que domain/ importe Prisma', () => {
    mkdirSync(join(violacion, 'domain'), { recursive: true })
    writeFileSync(
      join(violacion, 'domain', 'malo.ts'),
      "import { PrismaClient } from '@prisma/client'\nexport const x = PrismaClient\n",
    )

    const { code, salida } = correrCruiser()

    expect(code).not.toBe(0)
    expect(salida).toMatch(/domain-no-depende-de-nada/)
  })

  it('rechaza que application/ importe infrastructure/', () => {
    mkdirSync(join(violacion, 'application'), { recursive: true })
    mkdirSync(join(violacion, 'infrastructure'), { recursive: true })
    writeFileSync(join(violacion, 'infrastructure', 'repo.ts'), 'export const repo = 1\n')
    writeFileSync(
      join(violacion, 'application', 'caso.ts'),
      "import { repo } from '../infrastructure/repo'\nexport const y = repo\n",
    )

    const { code, salida } = correrCruiser()

    expect(code).not.toBe(0)
    expect(salida).toMatch(/application-solo-mira-a-domain/)
  })
})
```

- [ ] **Step 3: Ejecutar el test y verificar que falla**

Run: `npx vitest run test/architecture/dependency-rules.test.ts`
Expected: FAIL — no existe `.dependency-cruiser.cjs`.

- [ ] **Step 4: Escribir las reglas**

`.dependency-cruiser.cjs`:

```js
/**
 * La regla de dependencia de la Clean Architecture, como gate de CI.
 * Los nombres de las reglas los citan los tests de `test/architecture/`:
 * si renombras una, actualiza el test.
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-no-depende-de-nada',
      severity: 'error',
      comment:
        'domain/ es el núcleo: entidades y reglas puras. No conoce Prisma, ni NestJS, ni Zod, ' +
        'ni ningún paquete externo. Si necesita algo de fuera, es un puerto en application/.',
      from: { path: '^src/modules/[^/]+/domain' },
      to: {
        pathNot: '^src/(modules/[^/]+/domain|shared/domain)',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'application-solo-mira-a-domain',
      severity: 'error',
      comment: 'Los casos de uso no conocen adaptadores: dependen de puertos, que ellos definen.',
      from: { path: '^src/modules/[^/]+/application' },
      to: { path: '^src/modules/[^/]+/(infrastructure|interfaces)' },
    },
    {
      name: 'modulos-no-se-tocan-las-tripas',
      severity: 'error',
      comment:
        'Un módulo consume el puerto público de otro, nunca su infrastructure/. ' +
        'Cruzar esa línea convierte dos módulos en uno.',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/(?!$1)[^/]+/infrastructure' },
    },
    {
      name: 'sin-ciclos',
      severity: 'error',
      comment: 'Un ciclo de importación es una frontera de módulo mal puesta.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'sin-huerfanos',
      severity: 'warn',
      from: { orphan: true, pathNot: '\\.(test|spec)\\.ts$' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '\\.test\\.ts$' },
  },
}
```

- [ ] **Step 5: Ejecutar el test y verificar que pasa**

Run: `npx vitest run test/architecture/dependency-rules.test.ts`
Expected: PASS — 3 tests. El segundo y el tercero deben fallar el cruiser con el nombre de regla esperado.

- [ ] **Step 6: Escribir la configuración de ESLint**

`eslint.config.js`:

```js
import js from '@eslint/js'
import security from 'eslint-plugin-security'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  security.configs.recommended,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // Prisma parametriza todo salvo esta función. Es la única vía de
          // inyección SQL que el ORM deja abierta, así que se cierra aquí.
          selector: "MemberExpression[property.name='$queryRawUnsafe']",
          message: 'Prohibido $queryRawUnsafe. Usa $queryRaw con template tag, que parametriza.',
        },
        {
          selector: "MemberExpression[property.name='$executeRawUnsafe']",
          message: 'Prohibido $executeRawUnsafe. Usa $executeRaw con template tag.',
        },
        {
          // El entorno se lee sólo en src/config/env.ts (ver Tarea 1).
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message: 'No leas process.env aquí. Inyecta el token ENV de config/config.module.ts.',
        },
      ],
    },
  },
  {
    files: ['src/config/env.ts', 'src/config/config.module.ts', 'test/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
)
```

- [ ] **Step 7: Enganchar los gates a `npm run lint`**

En `package.json`:

```json
{
  "scripts": {
    "lint": "npm run lint:arch && eslint .",
    "lint:arch": "depcruise src --config .dependency-cruiser.cjs"
  }
}
```

`lint:arch` corre **primero**: si la arquitectura está rota, los avisos de estilo sobran.

- [ ] **Step 8: Verificar que ambos gates pasan en limpio**

Run: `npm run lint && npm run typecheck && npm test`
Expected: los tres en verde.

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat: gate arquitectonico con dependency-cruiser y ESLint

La regla de dependencia deja de ser un acuerdo y pasa a ser un gate de CI,
con tests que comprueban que el gate falla ante violaciones deliberadas.
ESLint cierra ademas \$queryRawUnsafe y la lectura dispersa de process.env."
```

---

### Task 3: Persistencia — Docker Compose, esquema Prisma y Testcontainers

**Files:**
- Create: `docker-compose.yml`, `prisma/schema.prisma`, `src/modules/database/prisma.service.ts`, `src/modules/database/database.module.ts`
- Create: `test/support/containers.ts`
- Test: `test/support/schema.test.ts`

**Interfaces:**
- Consumes: `ENV` de la Tarea 1.
- Produces: `PrismaService extends PrismaClient` (inyectable), `DatabaseModule`, y el helper de tests `startPostgres(): Promise<{ url: string; stop(): Promise<void> }>`.

**Por qué el esquema entero de una vez:** las restricciones del esquema (el `CHECK` XOR de `EventVendor`, el índice único parcial de `Guest`) son reglas de negocio expresadas en SQL. Partirlas entre ocho tareas produce ocho migraciones que se contradicen. Se declara el modelo completo aquí y cada tarea posterior le añade casos de uso, no columnas.

- [ ] **Step 1: Instalar y levantar la infraestructura local**

```bash
npm i @prisma/client @nestjs/config
npm i -D prisma @testcontainers/postgresql @testcontainers/redis testcontainers
npx prisma init --datasource-provider postgresql
```

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: wp
      POSTGRES_PASSWORD: wp
      POSTGRES_DB: wedding_planner
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U wp -d wedding_planner']
      interval: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      retries: 10

volumes:
  pgdata:
```

- [ ] **Step 2: Escribir el esquema Prisma completo**

`prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum SystemRole {
  USER
  ADMIN
}

enum EventRole {
  COUPLE
  PLANNER
}

enum MembershipStatus {
  INVITED
  ACTIVE
  REVOKED
}

enum VendorProfileStatus {
  DRAFT
  PUBLISHED
  SUSPENDED
}

enum EventVendorStatus {
  SHORTLISTED
  BOOKED
  CANCELLED
}

enum RsvpStatus {
  CONFIRMED
  PENDING
  DECLINED
}

enum InvitationStatus {
  QUEUED
  SENT
  DELIVERED
  BOUNCED
  COMPLAINED
  RESPONDED
}

model User {
  id              String     @id @default(uuid()) @db.Uuid
  email           String     @unique
  passwordHash    String
  fullName        String
  systemRole      SystemRole @default(USER)
  emailVerifiedAt DateTime?
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  sessions      Session[]
  memberships   EventMembership[]
  ownedEvents   Event[]           @relation("EventOwner")
  vendorProfile VendorProfile?
  notifications Notification[]

  @@map("users")
}

/// Refresh tokens. Se guarda el HASH, nunca el token. `familyId` agrupa la
/// cadena de rotaciones: presentar uno ya revocado sólo puede ser un robo, y
/// entonces cae la familia entera (ver Tarea 7).
model Session {
  id        String    @id @default(uuid()) @db.Uuid
  userId    String    @db.Uuid
  tokenHash String    @unique
  familyId  String    @db.Uuid
  expiresAt DateTime
  revokedAt DateTime?
  ip        String?
  userAgent String?
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([familyId])
  @@map("sessions")
}

/// Ficha de marketplace. Existe sin ningún evento: un proveedor puede
/// registrarse y publicarse con cero bodas contratadas.
model VendorProfile {
  id           String              @id @default(uuid()) @db.Uuid
  userId       String              @unique @db.Uuid
  businessName String
  category     String
  specialty    String?
  bio          String?
  contact      Json?
  status       VendorProfileStatus @default(DRAFT)
  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt

  user         User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  eventVendors EventVendor[]

  @@index([category, status])
  @@map("vendor_profiles")
}

model Event {
  id            String   @id @default(uuid()) @db.Uuid
  name          String
  weddingDate   DateTime
  timezone      String   @default("UTC")
  venueLocation String?
  ownerId       String   @db.Uuid
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  owner         User              @relation("EventOwner", fields: [ownerId], references: [id])
  memberships   EventMembership[]
  vendors       EventVendor[]
  guests        Guest[]
  notifications Notification[]

  @@index([ownerId])
  @@map("events")
}

/// Quienes PLANIFICAN el evento. No incluye vendors: ver EventVendor.
model EventMembership {
  id          String           @id @default(uuid()) @db.Uuid
  eventId     String           @db.Uuid
  userId      String           @db.Uuid
  role        EventRole
  status      MembershipStatus @default(ACTIVE)
  invitedById String?          @db.Uuid
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  event Event @relation(fields: [eventId], references: [id], onDelete: Cascade)
  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([eventId, userId])
  @@index([userId])
  @@map("event_memberships")
}

/// Quien TRABAJA en el evento: relación comercial, no membresía. O bien apunta
/// a una ficha del marketplace, o bien lleva los datos de un proveedor sin
/// cuenta. Exactamente uno de los dos — lo garantiza un CHECK, ver Step 3.
model EventVendor {
  id              String            @id @default(uuid()) @db.Uuid
  eventId         String            @db.Uuid
  vendorProfileId String?           @db.Uuid
  externalName    String?
  externalEmail   String?
  externalPhone   String?
  category        String
  specialty       String?
  assignedBudget  Decimal?          @db.Decimal(12, 2)
  status          EventVendorStatus @default(SHORTLISTED)
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt

  event         Event          @relation(fields: [eventId], references: [id], onDelete: Cascade)
  vendorProfile VendorProfile? @relation(fields: [vendorProfileId], references: [id])

  @@index([eventId])
  @@index([vendorProfileId])
  @@map("event_vendors")
}

/// `email` es opcional: se invita también por teléfono, en persona o por carta.
/// La unicidad es un índice PARCIAL (ver Step 3) para no estorbar a quien no
/// tiene correo, sin dejar de impedir invitar dos veces al mismo buzón.
model Guest {
  id        String     @id @default(uuid()) @db.Uuid
  eventId   String     @db.Uuid
  name      String
  email     String?
  group     String
  rsvp      RsvpStatus @default(PENDING)
  dietary   String?
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt

  event       Event             @relation(fields: [eventId], references: [id], onDelete: Cascade)
  invitations GuestInvitation[]

  // Orden estable de paginación por cursor: (createdAt, id) es único y total.
  @@index([eventId, createdAt, id])
  @@index([eventId, rsvp])
  @@map("guests")
}

model GuestInvitation {
  id              String           @id @default(uuid()) @db.Uuid
  guestId         String           @db.Uuid
  tokenHash       String           @unique
  status          InvitationStatus @default(QUEUED)
  resendMessageId String?
  sentAt          DateTime?
  respondedAt     DateTime?
  expiresAt       DateTime
  createdAt       DateTime         @default(now())

  guest Guest @relation(fields: [guestId], references: [id], onDelete: Cascade)

  @@index([guestId])
  @@index([resendMessageId])
  @@map("guest_invitations")
}

model Notification {
  id        String    @id @default(uuid()) @db.Uuid
  eventId   String    @db.Uuid
  userId    String    @db.Uuid
  type      String
  payload   Json
  readAt    DateTime?
  createdAt DateTime  @default(now())

  event Event @relation(fields: [eventId], references: [id], onDelete: Cascade)
  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, readAt])
  @@index([eventId, createdAt])
  @@map("notifications")
}

model AuditLog {
  id          String   @id @default(uuid()) @db.Uuid
  actorUserId String?  @db.Uuid
  eventId     String?  @db.Uuid
  action      String
  target      String
  metadata    Json?
  createdAt   DateTime @default(now())

  @@index([eventId, createdAt])
  @@index([actorUserId, createdAt])
  @@map("audit_logs")
}
```

- [ ] **Step 3: Añadir a mano las restricciones que Prisma no sabe declarar**

Prisma no expresa ni `CHECK` ni índices únicos parciales. Se generan vacías y se editan:

```bash
npx prisma migrate dev --name init --create-only
```

Al final del SQL generado, añadir:

```sql
-- Un EventVendor es O una ficha del marketplace O un proveedor externo, nunca
-- ambos ni ninguno. La base de datos es la última línea: sobrevive a los bugs
-- del código de aplicación.
ALTER TABLE "event_vendors"
  ADD CONSTRAINT "event_vendors_origen_exclusivo"
  CHECK (
    ("vendorProfileId" IS NOT NULL AND "externalName" IS NULL)
    OR
    ("vendorProfileId" IS NULL AND "externalName" IS NOT NULL)
  );

-- Índice único PARCIAL: impide dos invitados con el mismo correo en un evento,
-- y permite tantos invitados sin correo como haga falta. Postgres ya trata los
-- NULL como distintos, pero el índice parcial deja la intención escrita en el
-- esquema en vez de depender de que quien lo lea conozca esa sutileza del SQL.
CREATE UNIQUE INDEX "guests_event_email_unico"
  ON "guests" ("eventId", "email")
  WHERE "email" IS NOT NULL;
```

Aplicar: `npx prisma migrate dev`

- [ ] **Step 4: Escribir el harness de contenedores**

`test/support/containers.ts`:

```ts
import { execFileSync } from 'node:child_process'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

export interface PostgresDeTest {
  url: string
  stop: () => Promise<void>
}

/**
 * Postgres real en contenedor, con las migraciones aplicadas. NUNCA sqlite: un
 * dialecto distinto produce verdes falsos justo en lo que un repositorio existe
 * para hacer —restricciones, transacciones, el CHECK de event_vendors—, que es
 * lo único que un test de integración prueba de verdad.
 */
export async function startPostgres(): Promise<PostgresDeTest> {
  const contenedor: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('wedding_planner_test')
    .start()

  const url = contenedor.getConnectionUri()
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  })

  return { url, stop: () => contenedor.stop() }
}
```

- [ ] **Step 5: Escribir el test que falla — las restricciones de verdad**

`test/support/schema.test.ts`:

```ts
import { PrismaClient } from '@prisma/client'

import { startPostgres, type PostgresDeTest } from './containers'

describe('restricciones del esquema', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let eventId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    const owner = await prisma.user.create({
      data: { email: 'owner@test.com', passwordHash: 'x', fullName: 'Owner' },
    })
    const evento = await prisma.event.create({
      data: { name: 'Boda', weddingDate: new Date('2027-06-12'), ownerId: owner.id },
    })
    eventId = evento.id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  it('rechaza un EventVendor que sea a la vez de marketplace y externo', async () => {
    const perfilUser = await prisma.user.create({
      data: { email: 'vendor@test.com', passwordHash: 'x', fullName: 'Vendor' },
    })
    const perfil = await prisma.vendorProfile.create({
      data: { userId: perfilUser.id, businessName: 'Lumière', category: 'Catering' },
    })

    await expect(
      prisma.eventVendor.create({
        data: {
          eventId,
          vendorProfileId: perfil.id,
          externalName: 'También externo',
          category: 'Catering',
        },
      }),
    ).rejects.toThrow(/event_vendors_origen_exclusivo/)
  })

  it('rechaza un EventVendor sin ninguno de los dos orígenes', async () => {
    await expect(
      prisma.eventVendor.create({ data: { eventId, category: 'Flores' } }),
    ).rejects.toThrow(/event_vendors_origen_exclusivo/)
  })

  it('admite varios invitados sin email en el mismo evento', async () => {
    await prisma.guest.create({ data: { eventId, name: 'Tía Carmen', group: 'Family' } })
    await prisma.guest.create({ data: { eventId, name: 'Tío Paco', group: 'Family' } })

    const sinEmail = await prisma.guest.count({ where: { eventId, email: null } })
    expect(sinEmail).toBe(2)
  })

  it('impide dos invitados con el mismo email en el mismo evento', async () => {
    await prisma.guest.create({ data: { eventId, name: 'Ana', email: 'ana@test.com', group: 'Work' } })

    await expect(
      prisma.guest.create({ data: { eventId, name: 'Ana bis', email: 'ana@test.com', group: 'Work' } }),
    ).rejects.toThrow(/guests_event_email_unico/)
  })
})
```

- [ ] **Step 6: Ejecutar el test y verificar que falla, luego que pasa**

Run: `npx vitest run test/support/schema.test.ts`

Expected en el primer intento (sin el SQL del Step 3): FAIL — los dos primeros tests no lanzan nada, porque sin el `CHECK` Postgres acepta ambos `EventVendor`.
Expected tras aplicar el Step 3: PASS — 4 tests.

**Este es el orden que importa:** ver los dos primeros tests fallar demuestra que el `CHECK` es lo que los hace pasar, y no otra cosa.

- [ ] **Step 7: Exponer Prisma como servicio de Nest**

`src/modules/database/prisma.service.ts`:

```ts
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ datasources: { db: { url: env.DATABASE_URL } } })
  }

  async onModuleInit(): Promise<void> {
    await this.$connect()
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
```

`src/modules/database/database.module.ts`:

```ts
import { Global, Module } from '@nestjs/common'

import { PrismaService } from './prisma.service'

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class DatabaseModule {}
```

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat: esquema de datos completo con sus restricciones reales

El CHECK de exclusividad de event_vendors y el indice unico parcial de
guests se escriben a mano en la migracion: Prisma no los declara y son
reglas de negocio, no detalles. Tests de integracion contra Postgres real
via Testcontainers, nunca sqlite."
```

---

### Task 4: Kernel compartido — errores de dominio, filtro HTTP y cursor

**Files:**
- Create: `src/shared/domain/domain-error.ts`, `src/shared/domain/cursor.ts`
- Create: `src/shared/http/domain-exception.filter.ts`, `src/shared/http/request-id.middleware.ts`
- Create: `src/shared/logging/logger.ts`
- Test: `src/shared/domain/domain-error.test.ts`, `src/shared/domain/cursor.test.ts`, `src/shared/http/domain-exception.filter.test.ts`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces:
  - `abstract class DomainError extends Error` con `readonly code: string` y `readonly httpStatus: number`
  - `NotFoundError`, `ForbiddenError`, `ConflictError`, `UnprocessableError` (todas con `constructor(message: string, code?: string)`)
  - `encodeCursor(v: { createdAt: Date; id: string }): string` y `decodeCursor(raw: string): { createdAt: Date; id: string }`
  - `DomainExceptionFilter` (`@Catch()`), `RequestIdMiddleware`, `crearLogger(env: Env)`

- [ ] **Step 1: Escribir los tests que fallan**

`src/shared/domain/cursor.test.ts`:

```ts
import { decodeCursor, encodeCursor, InvalidCursorError } from './cursor'

describe('cursor de paginación', () => {
  it('sobrevive a un viaje de ida y vuelta', () => {
    const original = { createdAt: new Date('2026-09-17T10:30:00.000Z'), id: 'abc-123' }

    expect(decodeCursor(encodeCursor(original))).toEqual(original)
  })

  it('es opaco: no revela el id en claro', () => {
    expect(encodeCursor({ createdAt: new Date(), id: 'abc-123' })).not.toContain('abc-123')
  })

  it('rechaza un cursor manipulado en vez de devolver basura', () => {
    expect(() => decodeCursor('no-es-base64-valido!!')).toThrow(InvalidCursorError)
    expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow(InvalidCursorError)
  })
})
```

`src/shared/http/domain-exception.filter.test.ts`:

```ts
import { ArgumentsHost } from '@nestjs/common'

import { ConflictError, NotFoundError } from '../domain/domain-error'
import { DomainExceptionFilter } from './domain-exception.filter'

function hostFalso(): { host: ArgumentsHost; json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  const json = vi.fn()
  const status = vi.fn().mockReturnValue({ json })
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: '/events/1', requestId: 'req-1' }),
    }),
  } as unknown as ArgumentsHost

  return { host, json, status }
}

describe('DomainExceptionFilter', () => {
  it('traduce un error de dominio a su código HTTP y su code estable', () => {
    const { host, json, status } = hostFalso()

    new DomainExceptionFilter().catch(new NotFoundError('El evento no existe'), host)

    expect(status).toHaveBeenCalledWith(404)
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NOT_FOUND', message: 'El evento no existe', requestId: 'req-1' }),
    )
  })

  it('nunca incluye el stack en la respuesta', () => {
    const { host, json } = hostFalso()

    new DomainExceptionFilter().catch(new ConflictError('Ya existe'), host)

    expect(JSON.stringify(json.mock.calls[0])).not.toMatch(/at .*\.ts:/)
  })

  it('convierte un error desconocido en 500 sin filtrar su mensaje', () => {
    const { host, json, status } = hostFalso()

    new DomainExceptionFilter().catch(new Error('connect ECONNREFUSED 10.0.0.5:5432'), host)

    expect(status).toHaveBeenCalledWith(500)
    expect(json.mock.calls[0]?.[0]).toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(JSON.stringify(json.mock.calls[0])).not.toContain('10.0.0.5')
  })
})
```

El tercer test es el que justifica el filtro: un error de conexión sin filtrar le regala al atacante la topología interna de la red.

- [ ] **Step 2: Ejecutar los tests y verificar que fallan**

Run: `npx vitest run src/shared`
Expected: FAIL — módulos no encontrados.

- [ ] **Step 3: Escribir la jerarquía de errores**

`src/shared/domain/domain-error.ts`:

```ts
/**
 * Error que el DOMINIO sabe nombrar. Lleva su propio código HTTP porque la
 * traducción a HTTP es una decisión del dominio ("esto es un conflicto"), no
 * del controlador; así el mismo error responde igual desde REST, desde un job
 * de cola o desde un gateway de socket.
 */
export abstract class DomainError extends Error {
  abstract readonly httpStatus: number

  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class NotFoundError extends DomainError {
  readonly httpStatus = 404
  constructor(message: string, code = 'NOT_FOUND') {
    super(message, code)
  }
}

export class ForbiddenError extends DomainError {
  readonly httpStatus = 403
  constructor(message: string, code = 'FORBIDDEN') {
    super(message, code)
  }
}

export class ConflictError extends DomainError {
  readonly httpStatus = 409
  constructor(message: string, code = 'CONFLICT') {
    super(message, code)
  }
}

/** Petición bien formada pero imposible de cumplir. Ej.: invitar sin email. */
export class UnprocessableError extends DomainError {
  readonly httpStatus = 422
  constructor(message: string, code = 'UNPROCESSABLE') {
    super(message, code)
  }
}
```

- [ ] **Step 4: Escribir el cursor**

`src/shared/domain/cursor.ts`:

```ts
export class InvalidCursorError extends Error {
  constructor() {
    super('El cursor de paginación no es válido')
    this.name = 'InvalidCursorError'
  }
}

export interface CursorValue {
  createdAt: Date
  id: string
}

export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * Paginación por cursor, no por OFFSET: OFFSET degrada con la profundidad y,
 * peor, SALTA filas cuando alguien inserta mientras paginas. El par
 * (createdAt, id) es un orden total y estable, así que el cursor es exacto.
 *
 * Se codifica en base64url para que sea opaco: un cursor legible invita a
 * fabricarlo a mano, y entonces su formato pasa a ser API pública.
 */
export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify({ c: value.createdAt.toISOString(), i: value.id })).toString(
    'base64url',
  )
}

export function decodeCursor(raw: string): CursorValue {
  try {
    const crudo: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))

    if (
      typeof crudo !== 'object' ||
      crudo === null ||
      typeof (crudo as { c?: unknown }).c !== 'string' ||
      typeof (crudo as { i?: unknown }).i !== 'string'
    ) {
      throw new InvalidCursorError()
    }

    const { c, i } = crudo as { c: string; i: string }
    const createdAt = new Date(c)
    if (Number.isNaN(createdAt.getTime())) throw new InvalidCursorError()

    return { createdAt, id: i }
  } catch {
    throw new InvalidCursorError()
  }
}
```

- [ ] **Step 5: Escribir el filtro de excepciones**

`src/shared/http/domain-exception.filter.ts`:

```ts
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common'

import { DomainError, InvalidCursorError } from '../domain'

interface RespuestaDeError {
  code: string
  message: string
  requestId?: string
  details?: unknown
}

/**
 * Única salida de errores del backend. Regla: lo que no es un DomainError
 * conocido sale como 500 genérico. Un `connect ECONNREFUSED 10.0.0.5:5432`
 * devuelto al cliente le regala la topología interna a quien esté sondeando.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const req = ctx.getRequest<{ url?: string; requestId?: string }>()
    const res = ctx.getResponse<{ status: (code: number) => { json: (body: unknown) => void } }>()

    const { status, cuerpo } = this.traducir(exception)
    if (req.requestId !== undefined) cuerpo.requestId = req.requestId

    if (status >= 500) {
      this.logger.error({ err: exception, url: req.url, requestId: req.requestId }, 'Error no controlado')
    }

    res.status(status).json(cuerpo)
  }

  private traducir(exception: unknown): { status: number; cuerpo: RespuestaDeError } {
    if (exception instanceof DomainError) {
      return { status: exception.httpStatus, cuerpo: { code: exception.code, message: exception.message } }
    }

    if (exception instanceof InvalidCursorError) {
      return { status: 400, cuerpo: { code: 'INVALID_CURSOR', message: exception.message } }
    }

    if (exception instanceof HttpException) {
      const respuesta = exception.getResponse()
      return {
        status: exception.getStatus(),
        cuerpo: {
          code: 'HTTP_ERROR',
          message: exception.message,
          ...(typeof respuesta === 'object' ? { details: respuesta } : {}),
        },
      }
    }

    return {
      status: 500,
      cuerpo: { code: 'INTERNAL_ERROR', message: 'Ha ocurrido un error interno' },
    }
  }
}
```

Crear también `src/shared/domain/index.ts` que reexporte `domain-error.ts` y `cursor.ts`.

- [ ] **Step 6: Escribir requestId y logger**

`src/shared/http/request-id.middleware.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { Injectable, type NestMiddleware } from '@nestjs/common'

/**
 * Un identificador por petición, propagado a los logs y al payload de los jobs
 * (Tarea 6). Es lo que permite seguir "esta petición" desde el HTTP hasta el
 * correo que acabó produciendo, tres procesos más allá.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(
    req: { headers: Record<string, string | string[] | undefined>; requestId?: string },
    res: { setHeader: (k: string, v: string) => void },
    next: () => void,
  ): void {
    const entrante = req.headers['x-request-id']
    const id = typeof entrante === 'string' && entrante.length > 0 ? entrante : randomUUID()

    req.requestId = id
    res.setHeader('x-request-id', id)
    next()
  }
}
```

`src/shared/logging/logger.ts`:

```ts
import pino, { type Logger } from 'pino'

import type { Env } from '@/config/env.schema'

/**
 * Los campos redactados no son una lista de cortesía: un log con el header
 * Authorization convierte el sistema de logs en un almacén de credenciales, y
 * los logs se retienen, se exportan y se comparten con más gente que la base
 * de datos.
 */
export function crearLogger(env: Env): Logger {
  return pino({
    level: env.NODE_ENV === 'test' ? 'silent' : 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.tokenHash',
        '*.refreshToken',
      ],
      censor: '[REDACTADO]',
    },
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  })
}
```

```bash
npm i pino nestjs-pino
npm i -D pino-pretty
```

- [ ] **Step 7: Ejecutar los tests y verificar que pasan**

Run: `npx vitest run src/shared && npm run lint && npm run typecheck`
Expected: PASS — 6 tests, gates en verde.

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat: kernel compartido de errores, cursor y salida HTTP

Los errores de dominio llevan su codigo HTTP porque la traduccion es una
decision del dominio, no del controlador: asi responden igual desde REST,
desde un job y desde un socket. El filtro nunca deja salir stacks ni
mensajes de infraestructura."
```

---

### Task 5: Módulo `mail` — el puerto antes que el proveedor

**Files:**
- Create: `src/modules/mail/application/mail.port.ts`, `src/modules/mail/infrastructure/fake-mail.adapter.ts`, `src/modules/mail/infrastructure/resend-mail.adapter.ts`, `src/modules/mail/infrastructure/templates/guest-invitation.tsx`, `src/modules/mail/mail.module.ts`
- Test: `src/modules/mail/infrastructure/fake-mail.adapter.test.ts`

**Interfaces:**
- Consumes: `ENV` (Tarea 1), `DomainError` (Tarea 4).
- Produces:
  - `interface MailPort { send(mensaje: MailMessage): Promise<MailResult> }`
  - `interface MailMessage { to: string; subject: string; html: string; text: string; tags?: Record<string, string> }`
  - `interface MailResult { providerMessageId: string }`
  - `const MAIL_PORT: symbol` (token de inyección)
  - `class FakeMailAdapter implements MailPort` con `readonly enviados: MailMessage[]`
  - `renderGuestInvitation(datos: { guestName: string; eventName: string; weddingDate: string; rsvpUrl: string }): Promise<{ html: string; text: string }>`

**Por qué el puerto va antes que Resend:** todas las tareas que siguen necesitan mandar correo, y ninguna debe esperar a tener una API key. Con el puerto definido primero, los casos de uso se escriben y se prueban contra el doble desde el minuto cero, y el adaptador real es un detalle sustituible — que es exactamente lo que dice ser.

- [ ] **Step 1: Instalar**

```bash
npm i resend @react-email/components react react-dom
npm i -D @types/react
```

- [ ] **Step 2: Escribir el test que falla**

`src/modules/mail/infrastructure/fake-mail.adapter.test.ts`:

```ts
import { FakeMailAdapter } from './fake-mail.adapter'

describe('FakeMailAdapter', () => {
  it('acumula lo enviado para poder assertar sobre ello', async () => {
    const mail = new FakeMailAdapter()

    const resultado = await mail.send({
      to: 'ana@test.com',
      subject: 'Estás invitada',
      html: '<p>Hola</p>',
      text: 'Hola',
    })

    expect(mail.enviados).toHaveLength(1)
    expect(mail.enviados[0]?.to).toBe('ana@test.com')
    expect(resultado.providerMessageId).toMatch(/^fake-/)
  })

  it('devuelve un id distinto por envío, como haría el proveedor real', async () => {
    const mail = new FakeMailAdapter()
    const base = { subject: 's', html: 'h', text: 't' }

    const a = await mail.send({ ...base, to: 'a@test.com' })
    const b = await mail.send({ ...base, to: 'b@test.com' })

    expect(a.providerMessageId).not.toBe(b.providerMessageId)
  })

  it('puede simular un fallo del proveedor para probar los reintentos', async () => {
    const mail = new FakeMailAdapter()
    mail.fallarProximoEnvio(new Error('proveedor caído'))

    await expect(mail.send({ to: 'a@test.com', subject: 's', html: 'h', text: 't' })).rejects.toThrow(
      'proveedor caído',
    )
    expect(mail.enviados).toHaveLength(0)
  })
})
```

El tercer test existe porque sin él no hay forma de probar la política de reintentos de la Tarea 6 sin tirar la API real.

- [ ] **Step 3: Ejecutar y verificar que falla**

Run: `npx vitest run src/modules/mail`
Expected: FAIL — no existe `fake-mail.adapter`.

- [ ] **Step 4: Escribir el puerto**

`src/modules/mail/application/mail.port.ts`:

```ts
export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  /** Etiquetas del proveedor; sirven para segmentar métricas de entrega. */
  tags?: Record<string, string>
}

export interface MailResult {
  /** Id del proveedor. Es la clave por la que el webhook casa el evento. */
  providerMessageId: string
}

export interface MailPort {
  send(mensaje: MailMessage): Promise<MailResult>
}

export const MAIL_PORT = Symbol('MAIL_PORT')
```

- [ ] **Step 5: Escribir el adaptador fake**

`src/modules/mail/infrastructure/fake-mail.adapter.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import type { MailMessage, MailPort, MailResult } from '../application/mail.port'

/**
 * Adaptador de desarrollo y de test. En test se asserta sobre `enviados`; en
 * desarrollo evita que un `npm run dev` mande correo real a direcciones de
 * prueba, que es un accidente caro de deshacer.
 */
@Injectable()
export class FakeMailAdapter implements MailPort {
  readonly enviados: MailMessage[] = []
  private fallo: Error | null = null

  /** Hace fallar SÓLO el siguiente envío: así se prueban los reintentos. */
  fallarProximoEnvio(error: Error): void {
    this.fallo = error
  }

  send(mensaje: MailMessage): Promise<MailResult> {
    if (this.fallo !== null) {
      const error = this.fallo
      this.fallo = null
      return Promise.reject(error)
    }

    this.enviados.push(mensaje)
    return Promise.resolve({ providerMessageId: `fake-${randomUUID()}` })
  }
}
```

- [ ] **Step 6: Ejecutar y verificar que pasa**

Run: `npx vitest run src/modules/mail`
Expected: PASS — 3 tests.

- [ ] **Step 7: Escribir el adaptador Resend y la plantilla**

`src/modules/mail/infrastructure/resend-mail.adapter.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'
import { Resend } from 'resend'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import type { MailMessage, MailPort, MailResult } from '../application/mail.port'

@Injectable()
export class ResendMailAdapter implements MailPort {
  private readonly cliente: Resend

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.RESEND_API_KEY === undefined) {
      // Fail fast otra vez: MAIL_DRIVER=resend sin key es un despliegue roto
      // que sólo se notaría al intentar mandar el primer correo.
      throw new Error('MAIL_DRIVER=resend requiere RESEND_API_KEY')
    }
    this.cliente = new Resend(env.RESEND_API_KEY)
  }

  async send(mensaje: MailMessage): Promise<MailResult> {
    const { data, error } = await this.cliente.emails.send({
      from: this.env.MAIL_FROM,
      to: mensaje.to,
      subject: mensaje.subject,
      html: mensaje.html,
      text: mensaje.text,
      ...(mensaje.tags !== undefined
        ? { tags: Object.entries(mensaje.tags).map(([name, value]) => ({ name, value })) }
        : {}),
    })

    // Se lanza para que BullMQ reintente. Un error del proveedor devuelto como
    // valor se traga en silencio y la invitación se queda en QUEUED para siempre.
    if (error !== null) throw new Error(`Resend rechazó el envío: ${error.message}`)
    if (data === null) throw new Error('Resend no devolvió id de mensaje')

    return { providerMessageId: data.id }
  }
}
```

`src/modules/mail/infrastructure/templates/guest-invitation.tsx`:

```tsx
import { Body, Button, Container, Head, Heading, Html, Text } from '@react-email/components'
import { render } from '@react-email/components'

interface Props {
  guestName: string
  eventName: string
  weddingDate: string
  rsvpUrl: string
}

/** Plantilla de invitación. Se renderiza en el worker, nunca en el hilo HTTP. */
function GuestInvitation({ guestName, eventName, weddingDate, rsvpUrl }: Props) {
  return (
    <Html lang="en">
      <Head />
      <Body style={{ fontFamily: 'Georgia, serif', backgroundColor: '#faf7f2' }}>
        <Container style={{ padding: '32px' }}>
          <Heading>You are invited to {eventName}</Heading>
          <Text>Dear {guestName},</Text>
          <Text>We would be delighted to have you with us on {weddingDate}.</Text>
          <Button href={rsvpUrl} style={{ padding: '12px 24px' }}>
            Confirm your attendance
          </Button>
          <Text style={{ fontSize: '12px' }}>
            If the button does not work, open this link: {rsvpUrl}
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderGuestInvitation(datos: Props): Promise<{ html: string; text: string }> {
  const elemento = <GuestInvitation {...datos} />

  return {
    html: await render(elemento),
    // La versión en texto no es opcional: un correo sólo-HTML puntúa peor en
    // los filtros de spam, y una invitación en la bandeja de spam no existe.
    text: await render(elemento, { plainText: true }),
  }
}
```

- [ ] **Step 8: Escribir el módulo que elige el adaptador según el entorno**

`src/modules/mail/mail.module.ts`:

```ts
import { Module } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import { MAIL_PORT, type MailPort } from './application/mail.port'
import { FakeMailAdapter } from './infrastructure/fake-mail.adapter'
import { ResendMailAdapter } from './infrastructure/resend-mail.adapter'

@Module({
  providers: [
    {
      provide: MAIL_PORT,
      inject: [ENV],
      useFactory: (env: Env): MailPort =>
        env.MAIL_DRIVER === 'resend' ? new ResendMailAdapter(env) : new FakeMailAdapter(),
    },
  ],
  exports: [MAIL_PORT],
})
export class MailModule {}
```

- [ ] **Step 9: Verificar gates y commitear**

Run: `npm run lint && npm run typecheck && npm test`

```bash
git add .
git commit -m "feat: puerto de correo con adaptadores fake y Resend

El puerto va antes que el proveedor: los casos de uso que siguen se
escriben y se prueban contra el doble sin API key. El fake sabe fallar a
peticion para poder probar la politica de reintentos sin tocar Resend."
```

---

### Task 6: Módulo `queue` — colas BullMQ con idempotencia por `jobId`

**Files:**
- Create: `src/modules/queue/application/queue.port.ts`, `src/modules/queue/infrastructure/bullmq-queue.adapter.ts`, `src/modules/queue/infrastructure/in-memory-queue.adapter.ts`, `src/modules/queue/queue.module.ts`
- Test: `src/modules/queue/infrastructure/bullmq-queue.adapter.test.ts`

**Interfaces:**
- Consumes: `ENV` (Tarea 1).
- Produces:
  - `type QueueName = 'email' | 'notifications' | 'maintenance'`
  - `interface EnqueueOptions { jobId: string; delayMs?: number }`
  - `interface QueuePort { enqueue<T>(cola: QueueName, nombre: string, datos: T, opciones: EnqueueOptions): Promise<void> }`
  - `const QUEUE_PORT: symbol`
  - `class InMemoryQueueAdapter implements QueuePort` con `readonly encolados: Array<{ cola: QueueName; nombre: string; datos: unknown; jobId: string }>`
  - `const OPCIONES_POR_DEFECTO` (attempts, backoff, retención)

- [ ] **Step 1: Instalar**

```bash
npm i bullmq ioredis @nestjs/bullmq
```

- [ ] **Step 2: Escribir el test que falla**

`src/modules/queue/infrastructure/bullmq-queue.adapter.test.ts`:

```ts
import { Queue } from 'bullmq'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'

import { BullmqQueueAdapter } from './bullmq-queue.adapter'

describe('BullmqQueueAdapter', () => {
  let redis: StartedRedisContainer
  let adaptador: BullmqQueueAdapter
  let cola: Queue

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start()
    adaptador = new BullmqQueueAdapter({ REDIS_URL: redis.getConnectionUrl() })
    cola = new Queue('email', { connection: { url: redis.getConnectionUrl() } })
  }, 120_000)

  afterEach(async () => {
    await cola.obliterate({ force: true })
  })

  afterAll(async () => {
    await cola.close()
    await adaptador.onModuleDestroy()
    await redis.stop()
  })

  it('encola un job con el jobId que se le pide', async () => {
    await adaptador.enqueue('email', 'guest-invitation', { invitationId: 'inv-1' }, { jobId: 'invitation:inv-1' })

    const job = await cola.getJob('invitation:inv-1')
    expect(job?.data).toEqual({ invitationId: 'inv-1' })
  })

  it('NO duplica el job cuando se encola dos veces el mismo jobId', async () => {
    const datos = { invitationId: 'inv-1' }

    await adaptador.enqueue('email', 'guest-invitation', datos, { jobId: 'invitation:inv-1' })
    await adaptador.enqueue('email', 'guest-invitation', datos, { jobId: 'invitation:inv-1' })

    expect(await cola.getWaitingCount()).toBe(1)
  })

  it('configura reintentos con backoff exponencial', async () => {
    await adaptador.enqueue('email', 'guest-invitation', {}, { jobId: 'invitation:inv-2' })

    const job = await cola.getJob('invitation:inv-2')
    expect(job?.opts.attempts).toBe(5)
    expect(job?.opts.backoff).toMatchObject({ type: 'exponential' })
  })
})
```

`★ El segundo test es el corazón de la tarea.` Sin `jobId` determinista, un fallo de red *después* de que Resend aceptara el correo hace que el reintento mande un segundo correo. Con él, BullMQ descarta el duplicado y el reintento es seguro.

- [ ] **Step 3: Ejecutar y verificar que falla**

Run: `npx vitest run src/modules/queue`
Expected: FAIL — no existe `bullmq-queue.adapter`.

- [ ] **Step 4: Escribir el puerto**

`src/modules/queue/application/queue.port.ts`:

```ts
export type QueueName = 'email' | 'notifications' | 'maintenance'

export interface EnqueueOptions {
  /**
   * Identificador determinista del trabajo, derivado de la entidad que lo
   * origina (`invitation:<id>`). Es lo que hace idempotente el encolado: sin
   * él, reintentar una petición produce un segundo correo.
   */
  jobId: string
  delayMs?: number
}

export interface QueuePort {
  enqueue<T extends object>(
    cola: QueueName,
    nombre: string,
    datos: T,
    opciones: EnqueueOptions,
  ): Promise<void>
}

export const QUEUE_PORT = Symbol('QUEUE_PORT')
```

- [ ] **Step 5: Escribir los adaptadores**

`src/modules/queue/infrastructure/bullmq-queue.adapter.ts`:

```ts
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { Queue } from 'bullmq'

import { ENV } from '@/config/config.module'

import type { EnqueueOptions, QueueName, QueuePort } from '../application/queue.port'

/**
 * Política común de todos los jobs.
 *
 * `attempts: 5` con backoff exponencial desde 2s cubre las caídas cortas de un
 * proveedor sin martillearlo. `removeOnComplete` acotado evita que Redis crezca
 * sin límite; `removeOnFail: false` conserva los fallidos permanentes, que es
 * de donde sale la cola muerta y la alerta.
 */
export const OPCIONES_POR_DEFECTO = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: false,
}

@Injectable()
export class BullmqQueueAdapter implements QueuePort, OnModuleDestroy {
  private readonly colas = new Map<QueueName, Queue>()

  constructor(@Inject(ENV) private readonly env: { REDIS_URL: string }) {}

  private obtener(nombre: QueueName): Queue {
    const existente = this.colas.get(nombre)
    if (existente !== undefined) return existente

    const cola = new Queue(nombre, { connection: { url: this.env.REDIS_URL } })
    this.colas.set(nombre, cola)
    return cola
  }

  async enqueue<T extends object>(
    cola: QueueName,
    nombre: string,
    datos: T,
    opciones: EnqueueOptions,
  ): Promise<void> {
    await this.obtener(cola).add(nombre, datos, {
      ...OPCIONES_POR_DEFECTO,
      jobId: opciones.jobId,
      ...(opciones.delayMs !== undefined ? { delay: opciones.delayMs } : {}),
    })
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.colas.values()].map((cola) => cola.close()))
  }
}
```

`src/modules/queue/infrastructure/in-memory-queue.adapter.ts`:

```ts
import { Injectable } from '@nestjs/common'

import type { EnqueueOptions, QueueName, QueuePort } from '../application/queue.port'

interface Encolado {
  cola: QueueName
  nombre: string
  datos: unknown
  jobId: string
}

/**
 * Doble para los tests de casos de uso: permite assertar QUÉ se encoló sin
 * levantar Redis. Replica la deduplicación por jobId, que es la propiedad de
 * la que dependen los casos de uso.
 */
@Injectable()
export class InMemoryQueueAdapter implements QueuePort {
  readonly encolados: Encolado[] = []

  enqueue<T extends object>(
    cola: QueueName,
    nombre: string,
    datos: T,
    opciones: EnqueueOptions,
  ): Promise<void> {
    if (!this.encolados.some((e) => e.jobId === opciones.jobId)) {
      this.encolados.push({ cola, nombre, datos, jobId: opciones.jobId })
    }
    return Promise.resolve()
  }
}
```

- [ ] **Step 6: Ejecutar y verificar que pasa**

Run: `npx vitest run src/modules/queue`
Expected: PASS — 3 tests.

- [ ] **Step 7: Escribir el módulo**

`src/modules/queue/queue.module.ts`:

```ts
import { Global, Module } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import { QUEUE_PORT } from './application/queue.port'
import { BullmqQueueAdapter } from './infrastructure/bullmq-queue.adapter'

@Global()
@Module({
  providers: [
    { provide: QUEUE_PORT, inject: [ENV], useFactory: (env: Env) => new BullmqQueueAdapter(env) },
  ],
  exports: [QUEUE_PORT],
})
export class QueueModule {}
```

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat: puerto de colas sobre BullMQ con idempotencia por jobId

El jobId determinista es lo que hace seguros los reintentos: sin el, un
fallo de red despues de que el proveedor aceptara el correo produce un
segundo envio al reintentar. Test explicito de que encolar dos veces el
mismo jobId deja un solo job."
```

---

### Task 7: Usuarios y hashing de contraseñas con Argon2id

**Files:**
- Create: `src/modules/users/domain/user.ts`, `src/modules/users/domain/user-errors.ts`, `src/modules/users/application/password-hasher.port.ts`, `src/modules/users/application/user.repository.ts`, `src/modules/users/infrastructure/argon2-password-hasher.ts`, `src/modules/users/infrastructure/prisma-user.repository.ts`, `src/modules/users/users.module.ts`
- Test: `src/modules/users/infrastructure/argon2-password-hasher.test.ts`, `src/modules/users/domain/user.test.ts`

**Interfaces:**
- Consumes: `DomainError` (Tarea 4), `PrismaService` (Tarea 3).
- Produces:
  - `interface User { id: string; email: string; fullName: string; systemRole: 'USER' | 'ADMIN'; emailVerifiedAt: Date | null }`
  - `interface PasswordHasher { hash(plano: string): Promise<string>; verify(hash: string, plano: string): Promise<boolean> }`, token `PASSWORD_HASHER`
  - `interface UserRepository { findByEmail(email: string): Promise<UserConHash | null>; findById(id: string): Promise<User | null>; create(datos: { email: string; passwordHash: string; fullName: string }): Promise<User>; marcarEmailVerificado(id: string): Promise<void> }`, token `USER_REPOSITORY`
  - `class EmailYaRegistradoError extends ConflictError`
  - `normalizarEmail(email: string): string`

- [ ] **Step 1: Instalar Argon2**

```bash
npm i argon2
```

- [ ] **Step 2: Escribir los tests que fallan**

`src/modules/users/infrastructure/argon2-password-hasher.test.ts`:

```ts
import { Argon2PasswordHasher } from './argon2-password-hasher'

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher()

  it('produce un hash argon2id verificable', async () => {
    const hash = await hasher.hash('una-contraseña-larga')

    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await hasher.verify(hash, 'una-contraseña-larga')).toBe(true)
  })

  it('rechaza una contraseña incorrecta', async () => {
    const hash = await hasher.hash('correcta')

    expect(await hasher.verify(hash, 'incorrecta')).toBe(false)
  })

  it('genera hashes distintos para la misma contraseña (sal aleatoria)', async () => {
    expect(await hasher.hash('misma')).not.toBe(await hasher.hash('misma'))
  })

  it('NO trunca contraseñas largas, a diferencia de bcrypt', async () => {
    // bcrypt ignora todo lo que pase de 72 bytes: dos frases de contraseña
    // largas con el mismo prefijo serían intercambiables. Argon2 no.
    const base = 'a'.repeat(80)
    const hash = await hasher.hash(`${base}FINAL`)

    expect(await hasher.verify(hash, `${base}OTRO`)).toBe(false)
  })

  it('devuelve false en vez de lanzar ante un hash corrupto', async () => {
    // Un registro corrupto en la tabla no debe convertir el login en un 500:
    // eso distingue al atacante entre "usuario raro" y "usuario normal".
    expect(await hasher.verify('no-es-un-hash', 'lo-que-sea')).toBe(false)
  })
})
```

`src/modules/users/domain/user.test.ts`:

```ts
import { normalizarEmail } from './user'

describe('normalizarEmail', () => {
  it('baja a minúsculas y recorta', () => {
    expect(normalizarEmail('  Ana@Test.COM ')).toBe('ana@test.com')
  })

  it('hace que dos grafías del mismo buzón colisionen en el índice único', () => {
    expect(normalizarEmail('ANA@test.com')).toBe(normalizarEmail('ana@TEST.com'))
  })
})
```

- [ ] **Step 3: Ejecutar y verificar que fallan**

Run: `npx vitest run src/modules/users`
Expected: FAIL — módulos no encontrados.

- [ ] **Step 4: Escribir el dominio**

`src/modules/users/domain/user.ts`:

```ts
export type SystemRole = 'USER' | 'ADMIN'

export interface User {
  id: string
  email: string
  fullName: string
  systemRole: SystemRole
  emailVerifiedAt: Date | null
}

/** Como `User`, pero con el hash. Nunca sale de `application/` hacia fuera. */
export interface UserConHash extends User {
  passwordHash: string
}

/**
 * El email se normaliza SIEMPRE antes de tocar la base de datos. Sin esto,
 * `Ana@test.com` y `ana@test.com` son dos filas distintas para el índice único
 * y una sola persona para el mundo real: dos cuentas, y un login que falla sin
 * que el usuario entienda por qué.
 */
export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase()
}
```

`src/modules/users/domain/user-errors.ts`:

```ts
import { ConflictError, NotFoundError } from '@/shared/domain'

export class EmailYaRegistradoError extends ConflictError {
  constructor() {
    super('Ya existe una cuenta con ese email', 'EMAIL_ALREADY_REGISTERED')
  }
}

export class UsuarioNoEncontradoError extends NotFoundError {
  constructor() {
    super('El usuario no existe', 'USER_NOT_FOUND')
  }
}
```

- [ ] **Step 5: Escribir los puertos**

`src/modules/users/application/password-hasher.port.ts`:

```ts
export interface PasswordHasher {
  hash(plano: string): Promise<string>
  /** Devuelve `false` ante un hash corrupto; no lanza. */
  verify(hash: string, plano: string): Promise<boolean>
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER')
```

`src/modules/users/application/user.repository.ts`:

```ts
import type { User, UserConHash } from '../domain/user'

export interface UserRepository {
  findByEmail(email: string): Promise<UserConHash | null>
  findById(id: string): Promise<User | null>
  create(datos: { email: string; passwordHash: string; fullName: string }): Promise<User>
  marcarEmailVerificado(id: string): Promise<void>
}

export const USER_REPOSITORY = Symbol('USER_REPOSITORY')
```

- [ ] **Step 6: Escribir el hasher**

`src/modules/users/infrastructure/argon2-password-hasher.ts`:

```ts
import { Injectable } from '@nestjs/common'
import argon2 from 'argon2'

import type { PasswordHasher } from '../application/password-hasher.port'

/**
 * Argon2id, no bcrypt. Argon2 ganó el Password Hashing Competition y su coste
 * es en memoria además de en CPU, lo que le quita a un atacante con GPU o ASIC
 * la ventaja que sí tiene contra bcrypt. Y bcrypt sigue truncando a 72 bytes.
 *
 * Parámetros: los recomendados por OWASP para argon2id (19 MiB, 2 iteraciones,
 * paralelismo 1). Subirlos protege más pero encarece cada login: si se tocan,
 * hay que medir la latencia del login, no estimarla.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  private readonly opciones = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const

  hash(plano: string): Promise<string> {
    return argon2.hash(plano, this.opciones)
  }

  async verify(hash: string, plano: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plano)
    } catch {
      // Un hash corrupto en la tabla no puede producir un 500: la diferencia
      // entre 500 y 401 le dice al atacante que ese usuario existe y es raro.
      return false
    }
  }
}
```

- [ ] **Step 7: Escribir el repositorio Prisma**

`src/modules/users/infrastructure/prisma-user.repository.ts`:

```ts
import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'

import type { UserRepository } from '../application/user.repository'
import { normalizarEmail, type User, type UserConHash } from '../domain/user'
import { EmailYaRegistradoError } from '../domain/user-errors'

@Injectable()
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<UserConHash | null> {
    const fila = await this.prisma.user.findUnique({ where: { email: normalizarEmail(email) } })
    return fila === null ? null : { ...fila }
  }

  async findById(id: string): Promise<User | null> {
    const fila = await this.prisma.user.findUnique({ where: { id } })
    if (fila === null) return null

    const { passwordHash: _oculto, ...publico } = fila
    return publico
  }

  async create(datos: { email: string; passwordHash: string; fullName: string }): Promise<User> {
    try {
      const fila = await this.prisma.user.create({
        data: { ...datos, email: normalizarEmail(datos.email) },
      })
      const { passwordHash: _oculto, ...publico } = fila
      return publico
    } catch (error) {
      // P2002 = violación de índice único. Se traduce a un error de DOMINIO
      // aquí, en la frontera: dejarlo subir obligaría a los casos de uso a
      // conocer los códigos de Prisma, que es justo lo que el puerto evita.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new EmailYaRegistradoError()
      }
      throw error
    }
  }

  async marcarEmailVerificado(id: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { emailVerifiedAt: new Date() } })
  }
}
```

- [ ] **Step 8: Escribir el módulo, ejecutar y commitear**

`src/modules/users/users.module.ts` provee `PASSWORD_HASHER → Argon2PasswordHasher` y `USER_REPOSITORY → PrismaUserRepository`, y exporta ambos tokens.

Run: `npx vitest run src/modules/users && npm run lint && npm run typecheck`
Expected: PASS — 7 tests.

```bash
git add .
git commit -m "feat: usuarios con hashing Argon2id

Argon2id en vez de bcrypt: coste en memoria ademas de en CPU y sin el
truncado a 72 bytes, con test explicito de que dos frases largas con el
mismo prefijo no son intercambiables. Un hash corrupto devuelve false, no
un 500 que delataria que ese usuario existe."
```

---

### Task 8: Auth — registro, login y refresh rotativo con detección de reuso

**Files:**
- Create: `src/modules/auth/domain/token-errors.ts`, `src/modules/auth/application/{register.use-case.ts,login.use-case.ts,refresh.use-case.ts,logout.use-case.ts,session.repository.ts,token.service.ts}`, `src/modules/auth/infrastructure/prisma-session.repository.ts`, `src/modules/auth/interfaces/{auth.controller.ts,auth.dto.ts,jwt-auth.guard.ts,current-user.decorator.ts}`, `src/modules/auth/auth.module.ts`
- Test: `src/modules/auth/application/refresh.use-case.test.ts`, `src/modules/auth/application/login.use-case.test.ts`, `test/e2e/auth.e2e.test.ts`

**Interfaces:**
- Consumes: `UserRepository`, `PasswordHasher` (Tarea 7); `MAIL_PORT` (Tarea 5); `QUEUE_PORT` (Tarea 6); errores de `shared/domain` (Tarea 4).
- Produces:
  - `interface SessionRepository { crear(datos: { userId: string; tokenHash: string; familyId: string; expiresAt: Date }): Promise<void>; buscarPorHash(tokenHash: string): Promise<SesionPersistida | null>; revocar(id: string): Promise<void>; revocarFamilia(familyId: string): Promise<void> }`, token `SESSION_REPOSITORY`
  - `class TokenService { firmarAccess(user: { id: string; systemRole: string }): string; verificarAccess(token: string): { sub: string; role: string }; generarRefresh(): { token: string; hash: string } }`
  - `class RefreshUseCase { ejecutar(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> }`
  - `class RefreshReutilizadoError extends ForbiddenError` (code `REFRESH_REUSED`)
  - `JwtAuthGuard`, `@CurrentUser()` que inyecta `{ id: string; systemRole: SystemRole }`
  - `hashToken(token: string): string` (SHA-256 hex)

- [ ] **Step 1: Instalar**

```bash
npm i @nestjs/jwt cookie-parser
npm i -D @types/cookie-parser
```

- [ ] **Step 2: Escribir el test que falla — la detección de reuso**

`src/modules/auth/application/refresh.use-case.test.ts`:

```ts
import { RefreshUseCase } from './refresh.use-case'
import { RefreshReutilizadoError, RefreshInvalidoError } from '../domain/token-errors'
import { SessionRepositoryEnMemoria } from '../infrastructure/session.repository.fake'
import { TokenService } from './token.service'

describe('RefreshUseCase', () => {
  const tokens = new TokenService({ JWT_ACCESS_SECRET: 'x'.repeat(32), JWT_ACCESS_TTL: '15m', REFRESH_TTL_DAYS: 30 })
  let sesiones: SessionRepositoryEnMemoria
  let usuarios: UserRepositoryEnMemoria
  let caso: RefreshUseCase

  beforeEach(() => {
    sesiones = new SessionRepositoryEnMemoria()
    usuarios = new UserRepositoryEnMemoria([
      { id: 'user-1', email: 'a@test.com', fullName: 'A', systemRole: 'USER', emailVerifiedAt: null },
    ])
    caso = new RefreshUseCase(sesiones, usuarios, tokens)
  })

  async function emitirPrimero(): Promise<string> {
    const { token, hash } = tokens.generarRefresh()
    await sesiones.crear({
      userId: 'user-1',
      tokenHash: hash,
      familyId: 'familia-1',
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    return token
  }

  it('rota el refresh: devuelve uno nuevo y revoca el usado', async () => {
    const primero = await emitirPrimero()

    const resultado = await caso.ejecutar(primero)

    expect(resultado.refreshToken).not.toBe(primero)
    expect(resultado.accessToken).toMatch(/^eyJ/)
    expect(sesiones.estaRevocado(primero)).toBe(true)
  })

  it('detecta el reuso y revoca LA FAMILIA ENTERA', async () => {
    const primero = await emitirPrimero()
    const { refreshToken: segundo } = await caso.ejecutar(primero)

    // Presentar de nuevo el primero sólo puede significar que alguien lo robó:
    // el cliente legítimo ya tiene el segundo y nunca volvería al anterior.
    await expect(caso.ejecutar(primero)).rejects.toThrow(RefreshReutilizadoError)

    // Y el ladrón no puede seguir usando el que sí es válido.
    await expect(caso.ejecutar(segundo)).rejects.toThrow()
    expect(sesiones.familiaRevocada('familia-1')).toBe(true)
  })

  it('rechaza un refresh que no existe', async () => {
    await expect(caso.ejecutar('inventado')).rejects.toThrow(RefreshInvalidoError)
  })

  it('rechaza un refresh caducado', async () => {
    const { token, hash } = tokens.generarRefresh()
    await sesiones.crear({
      userId: 'user-1',
      tokenHash: hash,
      familyId: 'familia-1',
      expiresAt: new Date(Date.now() - 1_000),
    })

    await expect(caso.ejecutar(token)).rejects.toThrow(RefreshInvalidoError)
  })
})
```

`★ El segundo test es el motivo de toda esta maquinaria.` Con refresh tokens de larga vida y sin rotación, robar uno da acceso indefinido y silencioso. Con rotación por familia, el robo se delata solo: en cuanto el ladrón o la víctima refresca, el otro presenta un token ya usado y cae la sesión entera.

- [ ] **Step 3: Ejecutar y verificar que falla**

Run: `npx vitest run src/modules/auth`
Expected: FAIL — módulos no encontrados.

- [ ] **Step 4: Escribir errores, puerto y doble**

`src/modules/auth/domain/token-errors.ts`:

```ts
import { ForbiddenError } from '@/shared/domain'

export class RefreshInvalidoError extends ForbiddenError {
  constructor() {
    super('La sesión no es válida', 'REFRESH_INVALID')
  }
}

export class RefreshReutilizadoError extends ForbiddenError {
  constructor() {
    super('La sesión se ha cerrado por seguridad', 'REFRESH_REUSED')
  }
}
```

`src/modules/auth/application/session.repository.ts`:

```ts
export interface SesionPersistida {
  id: string
  userId: string
  familyId: string
  expiresAt: Date
  revokedAt: Date | null
}

export interface SessionRepository {
  crear(datos: { userId: string; tokenHash: string; familyId: string; expiresAt: Date }): Promise<void>
  buscarPorHash(tokenHash: string): Promise<SesionPersistida | null>
  revocar(id: string): Promise<void>
  revocarFamilia(familyId: string): Promise<void>
}

export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY')
```

`src/modules/auth/infrastructure/session.repository.fake.ts` implementa `SessionRepository` en memoria y añade los helpers de test `estaRevocado(token: string): boolean` y `familiaRevocada(familyId: string): boolean`.

- [ ] **Step 5: Escribir el servicio de tokens**

`src/modules/auth/application/token.service.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import jwt from 'jsonwebtoken'

import { ENV } from '@/config/config.module'

/** SHA-256 basta: el token ya es aleatorio de 32 bytes, no hay nada que forzar. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

interface ConfigTokens {
  JWT_ACCESS_SECRET: string
  JWT_ACCESS_TTL: string
  REFRESH_TTL_DAYS: number
}

@Injectable()
export class TokenService {
  constructor(@Inject(ENV) private readonly env: ConfigTokens) {}

  firmarAccess(user: { id: string; systemRole: string }): string {
    return jwt.sign({ sub: user.id, role: user.systemRole }, this.env.JWT_ACCESS_SECRET, {
      expiresIn: this.env.JWT_ACCESS_TTL,
    })
  }

  verificarAccess(token: string): { sub: string; role: string } {
    const payload = jwt.verify(token, this.env.JWT_ACCESS_SECRET)
    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      throw new Error('Payload de access token inválido')
    }
    return { sub: payload.sub, role: String(payload.role) }
  }

  /**
   * Refresh OPACO, no un JWT: no lleva claims, no se puede inspeccionar y se
   * revoca borrando una fila. Un JWT de refresh es irrevocable por diseño.
   * Se devuelve el token en claro (va al cliente) y su hash (va a la tabla):
   * la base de datos nunca guarda el token.
   */
  generarRefresh(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url')
    return { token, hash: hashToken(token) }
  }

  caducidadRefresh(): Date {
    return new Date(Date.now() + this.env.REFRESH_TTL_DAYS * 86_400_000)
  }
}
```

- [ ] **Step 6: Escribir el caso de uso de refresco**

`src/modules/auth/application/refresh.use-case.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'

import { RefreshInvalidoError, RefreshReutilizadoError } from '../domain/token-errors'
import { SESSION_REPOSITORY, type SessionRepository } from './session.repository'
import { hashToken, TokenService } from './token.service'

@Injectable()
export class RefreshUseCase {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sesiones: SessionRepository,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    private readonly tokens: TokenService,
  ) {}

  async ejecutar(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const sesion = await this.sesiones.buscarPorHash(hashToken(refreshToken))

    if (sesion === null) throw new RefreshInvalidoError()

    // Presentar un refresh YA REVOCADO sólo tiene una explicación: el cliente
    // legítimo ya rotó y guarda el siguiente, así que quien trae éste lo copió.
    // Se cae la familia entera, no sólo esta sesión: si no, el ladrón sigue
    // usando el token válido que obtuvo por el camino.
    if (sesion.revokedAt !== null) {
      await this.sesiones.revocarFamilia(sesion.familyId)
      throw new RefreshReutilizadoError()
    }

    if (sesion.expiresAt.getTime() <= Date.now()) throw new RefreshInvalidoError()

    await this.sesiones.revocar(sesion.id)

    const nuevo = this.tokens.generarRefresh()
    await this.sesiones.crear({
      userId: sesion.userId,
      tokenHash: nuevo.hash,
      familyId: sesion.familyId,
      expiresAt: this.tokens.caducidadRefresh(),
    })

    // El rol se relee del usuario, NO se asume: firmar siempre 'USER' degradaría
    // a un admin en cuanto refrescara, y cachearlo en la sesión dejaría vivo el
    // rol antiguo durante toda la vida del refresh tras un cambio de permisos.
    const usuario = await this.usuarios.findById(sesion.userId)
    if (usuario === null) throw new RefreshInvalidoError()

    return {
      accessToken: this.tokens.firmarAccess({ id: usuario.id, systemRole: usuario.systemRole }),
      refreshToken: nuevo.token,
    }
  }
}
```

Nota para quien implemente: `familyId` nuevo (`randomUUID()`) sólo se genera en `LoginUseCase`, nunca al refrescar — la familia identifica la cadena completa desde el login.

- [ ] **Step 7: Ejecutar y verificar que pasa**

Run: `npx vitest run src/modules/auth/application/refresh.use-case.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 8: Escribir login, registro y logout**

`LoginUseCase.ejecutar({ email, password, ip, userAgent })`:
- Busca por email normalizado.
- **Si el usuario no existe, verifica igualmente contra un hash señuelo fijo** antes de devolver `CredencialesInvalidasError`. Sin ese paso, el login de un email inexistente responde en 2 ms y el de uno existente en 60 ms: un atacante enumera cuentas sólo cronometrando.
- Mismo error y mismo código para "no existe" y "contraseña mal".
- Crea sesión con `familyId = randomUUID()`.

`RegisterUseCase.ejecutar({ email, password, fullName })`: hashea, crea el usuario, genera token de verificación y **encola** el correo (`jobId: verify-email:<userId>`). No manda nada en línea.

`LogoutUseCase.ejecutar(refreshToken)`: revoca la familia. Cerrar sesión cierra el dispositivo entero, no sólo el último token emitido.

- [ ] **Step 9: Escribir el controlador y el guard**

`AuthController` con `POST /auth/register|login|refresh|logout` y `GET /auth/me`.

Reglas de cookie, no negociables:

```ts
const COOKIE_REFRESH = 'wp_refresh'
const OPCIONES_COOKIE = {
  httpOnly: true,        // un XSS no puede leerla
  secure: true,          // sólo por TLS
  sameSite: 'strict',    // no viaja en peticiones de terceros → CSRF cerrado
  path: '/auth/refresh', // no se envía en ninguna otra ruta
  maxAge: env.REFRESH_TTL_DAYS * 86_400_000,
} as const
```

El **access token se devuelve en el cuerpo**, para que el frontend lo guarde en memoria. Nunca en `localStorage`: ahí un XSS lo lee. Nunca en cookie sin `httpOnly`: lo mismo.

`JwtAuthGuard` verifica el `Authorization: Bearer`, carga el usuario y lo deja en `req.user`; `@CurrentUser()` lo inyecta tipado.

- [ ] **Step 10: Escribir el e2e**

`test/e2e/auth.e2e.test.ts` con Postgres y Redis en contenedores:

```ts
it('el ciclo completo: registro, login, acceso, refresco y cierre', async () => {
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email: 'ana@test.com', password: 'una-contraseña-larga', fullName: 'Ana' })
    .expect(201)

  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email: 'ana@test.com', password: 'una-contraseña-larga' })
    .expect(200)

  const cookie = login.headers['set-cookie'][0] as string
  expect(cookie).toMatch(/HttpOnly/)
  expect(cookie).toMatch(/SameSite=Strict/)
  expect(login.body.accessToken).toBeDefined()
  expect(login.body.refreshToken).toBeUndefined() // va en cookie, no en el cuerpo

  await request(app.getHttpServer())
    .get('/auth/me')
    .set('Authorization', `Bearer ${login.body.accessToken}`)
    .expect(200)
})

it('devuelve el mismo error para email inexistente y contraseña incorrecta', async () => {
  const inexistente = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email: 'nadie@test.com', password: 'x'.repeat(12) })
    .expect(401)

  const malaClave = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email: 'ana@test.com', password: 'incorrecta-pero-larga' })
    .expect(401)

  expect(inexistente.body.code).toBe(malaClave.body.code)
  expect(inexistente.body.message).toBe(malaClave.body.message)
})
```

- [ ] **Step 11: Verificar y commitear**

Run: `npm run lint && npm run typecheck && npm test`

```bash
git add .
git commit -m "feat: auth con refresh rotativo y deteccion de reuso

Refresh opaco (no JWT: un JWT de refresh es irrevocable por diseno) con
rotacion por familia. Presentar uno ya usado solo puede ser un robo, asi
que cae la familia entera. El login verifica contra un hash senuelo
cuando el usuario no existe: sin eso se enumeran cuentas cronometrando."
```

---

### Task 9: Eventos y el punto único de autorización

**Files:**
- Create: `src/modules/events/domain/event-access.ts`, `src/modules/events/application/{event-access.service.ts,event.repository.ts,create-event.use-case.ts,list-events.use-case.ts,invite-member.use-case.ts}`, `src/modules/events/infrastructure/prisma-event.repository.ts`, `src/modules/events/interfaces/{events.controller.ts,event-access.guard.ts,require-event-access.decorator.ts}`, `src/modules/events/events.module.ts`
- Test: `src/modules/events/application/event-access.service.test.ts`, `test/e2e/event-access.e2e.test.ts`

**Interfaces:**
- Consumes: `PrismaService` (T3), `JwtAuthGuard` y `@CurrentUser()` (T8), `NotFoundError`/`ForbiddenError` (T4).
- Produces:
  - ```ts
    export type EventAccess =
      | { kind: 'admin' }
      | { kind: 'member'; role: 'COUPLE' | 'PLANNER' }
      | { kind: 'vendor'; eventVendorId: string }
      | { kind: 'none' }
    ```
  - `interface EventRepository { buscarMembresiaActiva(eventId: string, userId: string): Promise<{ role: EventRole } | null>; buscarContratacionReservada(eventId: string, userId: string): Promise<{ id: string } | null>; crearConMembresia(datos: { name: string; weddingDate: Date; ownerId: string }): Promise<Event>; listarAccesiblesPor(userId: string): Promise<Event[]> }`, token `EVENT_REPOSITORY`
  - `class EventAccessService { resolve(userId: string, systemRole: 'USER' | 'ADMIN', eventId: string): Promise<EventAccess> }`
  - `EventAccessGuard`, `@RequireEventAccess(...permitidos: Array<'COUPLE' | 'PLANNER' | 'VENDOR'>)`
  - `@EventAccessOf()` — decorador de parámetro que inyecta el `EventAccess` resuelto

**Por qué un servicio y no comprobaciones en cada controlador:** el acceso a un evento tiene ahora dos fuentes (`EventMembership` y `EventVendor`), y en cuanto la comprobación se reparte, una de las dos se olvida en algún endpoint. Concentrarla significa además que **el mismo código autoriza REST y sockets** (Tarea 14), así que los permisos del tiempo real no pueden divergir de los del HTTP.

- [ ] **Step 1: Escribir el test que falla**

`src/modules/events/application/event-access.service.test.ts`:

```ts
import { EventAccessService } from './event-access.service'
import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'

describe('EventAccessService', () => {
  let repo: EventRepositoryEnMemoria
  let servicio: EventAccessService

  beforeEach(() => {
    repo = new EventRepositoryEnMemoria()
    repo.eventos.push({ id: 'ev-1', ownerId: 'user-pareja' })
    servicio = new EventAccessService(repo)
  })

  it('resuelve COUPLE para un miembro activo con ese rol', async () => {
    repo.membresias.push({ eventId: 'ev-1', userId: 'user-pareja', role: 'COUPLE', status: 'ACTIVE' })

    expect(await servicio.resolve('user-pareja', 'USER', 'ev-1')).toEqual({
      kind: 'member',
      role: 'COUPLE',
    })
  })

  it('resuelve PLANNER, y el mismo usuario puede ser COUPLE en otro evento', async () => {
    repo.eventos.push({ id: 'ev-2', ownerId: 'user-planner' })
    repo.membresias.push({ eventId: 'ev-1', userId: 'user-planner', role: 'PLANNER', status: 'ACTIVE' })
    repo.membresias.push({ eventId: 'ev-2', userId: 'user-planner', role: 'COUPLE', status: 'ACTIVE' })

    expect(await servicio.resolve('user-planner', 'USER', 'ev-1')).toEqual({ kind: 'member', role: 'PLANNER' })
    expect(await servicio.resolve('user-planner', 'USER', 'ev-2')).toEqual({ kind: 'member', role: 'COUPLE' })
  })

  it('una membresía REVOKED no da acceso', async () => {
    repo.membresias.push({ eventId: 'ev-1', userId: 'ex', role: 'PLANNER', status: 'REVOKED' })

    expect(await servicio.resolve('ex', 'USER', 'ev-1')).toEqual({ kind: 'none' })
  })

  it('una membresía INVITED tampoco: invitar no es aceptar', async () => {
    repo.membresias.push({ eventId: 'ev-1', userId: 'pendiente', role: 'PLANNER', status: 'INVITED' })

    expect(await servicio.resolve('pendiente', 'USER', 'ev-1')).toEqual({ kind: 'none' })
  })

  it('resuelve vendor sólo cuando la contratación está BOOKED', async () => {
    repo.perfiles.push({ id: 'perfil-1', userId: 'user-vendor' })
    repo.eventVendors.push({ id: 'ev-v-1', eventId: 'ev-1', vendorProfileId: 'perfil-1', status: 'BOOKED' })

    expect(await servicio.resolve('user-vendor', 'USER', 'ev-1')).toEqual({
      kind: 'vendor',
      eventVendorId: 'ev-v-1',
    })
  })

  it('un vendor sólo SHORTLISTED no tiene acceso', async () => {
    repo.perfiles.push({ id: 'perfil-2', userId: 'user-candidato' })
    repo.eventVendors.push({ id: 'ev-v-2', eventId: 'ev-1', vendorProfileId: 'perfil-2', status: 'SHORTLISTED' })

    expect(await servicio.resolve('user-candidato', 'USER', 'ev-1')).toEqual({ kind: 'none' })
  })

  it('un vendor externo no da acceso a nadie: no hay cuenta detrás', async () => {
    repo.eventVendors.push({ id: 'ev-v-3', eventId: 'ev-1', vendorProfileId: null, status: 'BOOKED' })

    expect(await servicio.resolve('cualquiera', 'USER', 'ev-1')).toEqual({ kind: 'none' })
  })

  it('un ADMIN accede a cualquier evento sin membresía', async () => {
    expect(await servicio.resolve('root', 'ADMIN', 'ev-1')).toEqual({ kind: 'admin' })
  })

  it('un desconocido no obtiene acceso', async () => {
    expect(await servicio.resolve('nadie', 'USER', 'ev-1')).toEqual({ kind: 'none' })
  })
})
```

Los tres tests de estados intermedios (`REVOKED`, `INVITED`, `SHORTLISTED`) son los que de verdad prueban algo: el camino feliz lo acierta cualquier implementación.

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run src/modules/events`
Expected: FAIL — no existe `event-access.service`.

- [ ] **Step 3: Escribir el tipo de acceso**

`src/modules/events/domain/event-access.ts`:

```ts
export type EventRole = 'COUPLE' | 'PLANNER'

/**
 * Acceso EFECTIVO de un usuario a un evento, resuelto sobre las dos fuentes
 * que existen: la membresía (quien planifica) y la contratación (quien trabaja).
 * Es una unión discriminada a propósito: obliga a quien lo consume a decidir
 * qué hace en cada caso, en vez de un booleano que pierde la razón del acceso.
 */
export type EventAccess =
  | { kind: 'admin' }
  | { kind: 'member'; role: EventRole }
  | { kind: 'vendor'; eventVendorId: string }
  | { kind: 'none' }

export function tieneAlgunAcceso(acceso: EventAccess): boolean {
  return acceso.kind !== 'none'
}
```

- [ ] **Step 4: Escribir el servicio**

`src/modules/events/application/event-access.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'

import type { EventAccess } from '../domain/event-access'
import { EVENT_REPOSITORY, type EventRepository } from './event.repository'

@Injectable()
export class EventAccessService {
  constructor(@Inject(EVENT_REPOSITORY) private readonly repo: EventRepository) {}

  async resolve(userId: string, systemRole: 'USER' | 'ADMIN', eventId: string): Promise<EventAccess> {
    if (systemRole === 'ADMIN') return { kind: 'admin' }

    const membresia = await this.repo.buscarMembresiaActiva(eventId, userId)
    if (membresia !== null) return { kind: 'member', role: membresia.role }

    // Sólo BOOKED, y sólo con ficha enlazada: un EventVendor externo no tiene
    // cuenta detrás, así que no puede conceder acceso a ningún usuario.
    const contratacion = await this.repo.buscarContratacionReservada(eventId, userId)
    if (contratacion !== null) return { kind: 'vendor', eventVendorId: contratacion.id }

    return { kind: 'none' }
  }
}
```

- [ ] **Step 5: Ejecutar y verificar que pasa**

Run: `npx vitest run src/modules/events/application/event-access.service.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 6: Escribir el guard y su decorador**

`src/modules/events/interfaces/event-access.guard.ts`:

```ts
import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { ForbiddenError, NotFoundError } from '@/shared/domain'

import { EventAccessService } from '../application/event-access.service'
import { PERMITIDOS } from './require-event-access.decorator'

@Injectable()
export class EventAccessGuard implements CanActivate {
  constructor(
    private readonly acceso: EventAccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const req = contexto.switchToHttp().getRequest<{
      params: Record<string, string | undefined>
      user: { id: string; systemRole: 'USER' | 'ADMIN' }
      eventAccess?: unknown
    }>()

    const eventId = req.params.eventId
    if (eventId === undefined) throw new NotFoundError('El evento no existe')

    const resultado = await this.acceso.resolve(req.user.id, req.user.systemRole, eventId)

    // 404, NO 403. Un 403 confirma que el evento existe a quien no debería
    // saberlo, y convierte cada ruta en un oráculo para enumerar la plataforma.
    if (resultado.kind === 'none') throw new NotFoundError('El evento no existe')

    const permitidos = this.reflector.get<string[] | undefined>(PERMITIDOS, contexto.getHandler())

    if (permitidos !== undefined && resultado.kind !== 'admin') {
      const mio = resultado.kind === 'vendor' ? 'VENDOR' : resultado.role
      // Aquí SÍ 403: ya sabemos que tiene acceso al evento, así que decirle
      // que no puede hacer *esta* operación no le revela nada nuevo.
      if (!permitidos.includes(mio)) {
        throw new ForbiddenError('No tienes permiso para esta operación en este evento')
      }
    }

    req.eventAccess = resultado
    return true
  }
}
```

`require-event-access.decorator.ts` exporta `export const PERMITIDOS = 'permitidos'` y `RequireEventAccess(...roles)` como `SetMetadata(PERMITIDOS, roles)`.

- [ ] **Step 7: Escribir los casos de uso y el controlador**

- `CreateEventUseCase`: crea `Event` **y** la `EventMembership` del creador con rol `COUPLE`, en **una transacción**. Un evento sin membresía es un evento al que ni su dueño puede entrar.
- `ListEventsUseCase`: devuelve los eventos con membresía activa, más las contrataciones `BOOKED` si el usuario tiene `VendorProfile`.
- `InviteMemberUseCase`: crea la membresía en `INVITED` y encola el correo. Requiere `COUPLE`. Escribe en `AuditLog`.

`EventsController` bajo `@UseGuards(JwtAuthGuard)`, y `@UseGuards(EventAccessGuard)` en las rutas con `:eventId`.

- [ ] **Step 8: Escribir el e2e de autorización**

`test/e2e/event-access.e2e.test.ts`:

```ts
it('un usuario sin acceso recibe 404, no 403', async () => {
  const otro = await registrarYEntrar('otro@test.com')

  const respuesta = await request(app.getHttpServer())
    .get(`/events/${eventoDeAna}`)
    .set('Authorization', `Bearer ${otro.accessToken}`)
    .expect(404)

  // El cuerpo no debe distinguirse del de un evento que no existe.
  const inventado = await request(app.getHttpServer())
    .get('/events/00000000-0000-0000-0000-000000000000')
    .set('Authorization', `Bearer ${otro.accessToken}`)
    .expect(404)

  expect(respuesta.body.code).toBe(inventado.body.code)
})

it('un planner con dos eventos ve sólo los invitados de cada uno', async () => {
  const deA = await listarInvitados(planner.accessToken, eventoA)
  const deB = await listarInvitados(planner.accessToken, eventoB)

  expect(deA.map((g) => g.name)).toEqual(['Invitado de A'])
  expect(deB.map((g) => g.name)).toEqual(['Invitado de B'])
})
```

- [ ] **Step 9: Verificar y commitear**

Run: `npm run lint && npm run typecheck && npm test`

```bash
git add .
git commit -m "feat: eventos y punto unico de autorizacion

EventAccessService resuelve el acceso efectivo sobre las dos fuentes que
existen —membresia y contratacion— y el mismo servicio autorizara los
sockets, para que REST y tiempo real no puedan divergir. Sin acceso se
responde 404 y no 403: un 403 confirma que el evento existe."
```

---

### Task 10: Vendors — ficha de marketplace y contratación por evento

**Files:**
- Create: `src/modules/vendors/domain/{vendor-ref.ts,vendor-errors.ts}`, `src/modules/vendors/application/{event-vendor.repository.ts,add-event-vendor.use-case.ts,list-event-vendors.use-case.ts}`, `src/modules/vendors/infrastructure/prisma-event-vendor.repository.ts`, `src/modules/vendors/interfaces/{event-vendors.controller.ts,event-vendor.dto.ts}`, `src/modules/vendors/vendors.module.ts`
- Test: `src/modules/vendors/domain/vendor-ref.test.ts`, `src/modules/vendors/application/add-event-vendor.use-case.test.ts`

**Interfaces:**
- Consumes: `EventAccessGuard`, `@RequireEventAccess` (T9); `PrismaService` (T3).
- Produces:
  - ```ts
    export type VendorRef =
      | { kind: 'linked'; vendorProfileId: string }
      | { kind: 'external'; name: string; email: string | null; phone: string | null }
    ```
  - `parseVendorRef(entrada: EntradaVendorRef): VendorRef` — lanza `VendorRefAmbiguaError` o `VendorRefVaciaError`
  - `class AddEventVendorUseCase { ejecutar(eventId: string, datos: CrearEventVendor): Promise<EventVendorVista> }`

**Alcance:** sólo lo que la spec pone dentro — `VendorProfile` como modelo y la gestión de `EventVendor`. El marketplace (búsqueda, paquetes, portfolio, ficha pública) **no** entra.

- [ ] **Step 1: Escribir el test que falla**

`src/modules/vendors/domain/vendor-ref.test.ts`:

```ts
import { parseVendorRef, VendorRefAmbiguaError, VendorRefVaciaError } from './vendor-ref'

describe('parseVendorRef', () => {
  it('acepta una referencia al marketplace', () => {
    expect(parseVendorRef({ vendorProfileId: 'perfil-1' })).toEqual({
      kind: 'linked',
      vendorProfileId: 'perfil-1',
    })
  })

  it('acepta un proveedor externo con sus datos', () => {
    expect(parseVendorRef({ externalName: 'Flores Pepa', externalEmail: 'pepa@flores.es' })).toEqual({
      kind: 'external',
      name: 'Flores Pepa',
      email: 'pepa@flores.es',
      phone: null,
    })
  })

  it('rechaza traer ambos, antes de llegar al CHECK de Postgres', () => {
    expect(() => parseVendorRef({ vendorProfileId: 'perfil-1', externalName: 'Flores Pepa' })).toThrow(
      VendorRefAmbiguaError,
    )
  })

  it('rechaza no traer ninguno', () => {
    expect(() => parseVendorRef({})).toThrow(VendorRefVaciaError)
  })

  it('un nombre externo en blanco cuenta como ausente', () => {
    expect(() => parseVendorRef({ externalName: '   ' })).toThrow(VendorRefVaciaError)
  })
})
```

El dominio valida lo mismo que el `CHECK` de la Tarea 3, y eso **no es duplicación inútil**: la restricción de base de datos garantiza la integridad, pero produce un error de Postgres; el value object produce un `422` que dice qué está mal. Las dos capas hacen falta y responden a preguntas distintas.

- [ ] **Step 2: Ejecutar, verificar que falla, escribir el value object**

`src/modules/vendors/domain/vendor-ref.ts`:

```ts
import { UnprocessableError } from '@/shared/domain'

export type VendorRef =
  | { kind: 'linked'; vendorProfileId: string }
  | { kind: 'external'; name: string; email: string | null; phone: string | null }

export class VendorRefAmbiguaError extends UnprocessableError {
  constructor() {
    super(
      'Un proveedor del evento es o bien una ficha del marketplace o bien externo, no ambos',
      'VENDOR_REF_AMBIGUA',
    )
  }
}

export class VendorRefVaciaError extends UnprocessableError {
  constructor() {
    super('Indica una ficha del marketplace o los datos de un proveedor externo', 'VENDOR_REF_VACIA')
  }
}

export interface EntradaVendorRef {
  vendorProfileId?: string | undefined
  externalName?: string | undefined
  externalEmail?: string | undefined
  externalPhone?: string | undefined
}

export function parseVendorRef(entrada: EntradaVendorRef): VendorRef {
  const enlazado = entrada.vendorProfileId?.trim() ?? ''
  const nombre = entrada.externalName?.trim() ?? ''

  if (enlazado !== '' && nombre !== '') throw new VendorRefAmbiguaError()
  if (enlazado === '' && nombre === '') throw new VendorRefVaciaError()

  if (enlazado !== '') return { kind: 'linked', vendorProfileId: enlazado }

  return {
    kind: 'external',
    name: nombre,
    email: entrada.externalEmail?.trim() ?? null,
    phone: entrada.externalPhone?.trim() ?? null,
  }
}
```

- [ ] **Step 3: Ejecutar y verificar que pasa**

Run: `npx vitest run src/modules/vendors`
Expected: PASS — 5 tests.

- [ ] **Step 4: Escribir el caso de uso, el repositorio y el controlador**

`AddEventVendorUseCase.ejecutar(eventId, datos)`:
1. `parseVendorRef(datos)` — falla pronto y con un mensaje útil.
2. Si es `linked`, comprueba que la `VendorProfile` existe y su `status` es `PUBLISHED`; si no, `NotFoundError`. Contratar una ficha en borrador o suspendida no debe poder.
3. Persiste el `EventVendor`.
4. `AuditLog` con `action: 'event_vendor.added'`.

Rutas, todas bajo `@RequireEventAccess('COUPLE', 'PLANNER')`:

```
GET    /events/:eventId/vendors
POST   /events/:eventId/vendors
PATCH  /events/:eventId/vendors/:eventVendorId
DELETE /events/:eventId/vendors/:eventVendorId
```

- [ ] **Step 5: Verificar y commitear**

```bash
git add .
git commit -m "feat: contratacion de vendors por evento, enlazados o externos

VendorRef como union discriminada: el dominio da un 422 con motivo y el
CHECK de Postgres garantiza la integridad. Las dos capas responden a
preguntas distintas y ninguna sustituye a la otra."
```

---

### Task 11: Invitados — CRUD, paginación por cursor, filtros y resumen derivado

**Files:**
- Create: `src/modules/guests/domain/{guest.ts,guest-errors.ts}`, `src/modules/guests/application/{guest.repository.ts,list-guests.use-case.ts,create-guest.use-case.ts,update-guest.use-case.ts,delete-guest.use-case.ts,guest-summary.use-case.ts}`, `src/modules/guests/infrastructure/prisma-guest.repository.ts`, `src/modules/guests/interfaces/{guests.controller.ts,guest.dto.ts}`, `src/modules/guests/guests.module.ts`
- Test: `src/modules/guests/application/list-guests.use-case.test.ts`, `src/modules/guests/infrastructure/prisma-guest.repository.test.ts`, `test/e2e/guests.e2e.test.ts`

**Interfaces:**
- Consumes: `encodeCursor`/`decodeCursor`/`CursorPage` (T4), `EventAccessGuard` (T9), `PrismaService` (T3).
- Produces:
  - `type RsvpStatus = 'CONFIRMED' | 'PENDING' | 'DECLINED'`
  - `interface Guest { id: string; eventId: string; name: string; email: string | null; group: string; rsvp: RsvpStatus; dietary: string | null; createdAt: Date }`
  - `interface GuestFilters { rsvp?: RsvpStatus; group?: string; q?: string }`
  - `interface GuestRepository { listar(eventId: string, filtros: GuestFilters, cursor: CursorValue | null, limite: number): Promise<CursorPage<Guest>>; contarPorEstado(eventId: string): Promise<Record<RsvpStatus, number>>; crear(...): Promise<Guest>; buscar(eventId, guestId): Promise<Guest | null>; actualizar(...): Promise<Guest>; borrar(eventId: string, guestId: string): Promise<void>; listarTodos(eventId: string): Promise<Guest[]> }`, token `GUEST_REPOSITORY`
  - `class GuestSummaryUseCase { ejecutar(eventId: string): Promise<{ total: number; confirmed: number; pending: number; declined: number }> }`
  - `class EmailDuplicadoError extends ConflictError`

- [ ] **Step 1: Escribir el test de paginación que falla**

`src/modules/guests/infrastructure/prisma-guest.repository.test.ts` (integración, Postgres real):

```ts
describe('PrismaGuestRepository — paginación por cursor', () => {
  // ...montaje con startPostgres(), un evento y 10 invitados creados en orden

  it('devuelve la primera página con su cursor', async () => {
    const pagina = await repo.listar(eventId, {}, null, 4)

    expect(pagina.items).toHaveLength(4)
    expect(pagina.items.map((g) => g.name)).toEqual(['G00', 'G01', 'G02', 'G03'])
    expect(pagina.nextCursor).not.toBeNull()
  })

  it('continúa exactamente donde lo dejó', async () => {
    const primera = await repo.listar(eventId, {}, null, 4)
    const segunda = await repo.listar(eventId, {}, decodeCursor(primera.nextCursor!), 4)

    expect(segunda.items.map((g) => g.name)).toEqual(['G04', 'G05', 'G06', 'G07'])
  })

  it('NO salta filas cuando alguien inserta mientras paginas', async () => {
    // Esto es lo que OFFSET hace mal y por lo que existe el cursor. Con
    // OFFSET 4, insertar una fila anterior desplaza todo y G03 se ve dos
    // veces mientras G04 no se ve nunca.
    const primera = await repo.listar(eventId, {}, null, 4)
    await crearInvitadoCon({ nombre: 'Intruso', createdAt: new Date(0) })

    const segunda = await repo.listar(eventId, {}, decodeCursor(primera.nextCursor!), 4)

    expect(segunda.items.map((g) => g.name)).toEqual(['G04', 'G05', 'G06', 'G07'])
  })

  it('devuelve nextCursor null en la última página', async () => {
    const ultima = await repo.listar(eventId, {}, null, 50)

    expect(ultima.nextCursor).toBeNull()
  })

  it('filtra por estado de RSVP', async () => {
    const confirmados = await repo.listar(eventId, { rsvp: 'CONFIRMED' }, null, 50)

    expect(confirmados.items.every((g) => g.rsvp === 'CONFIRMED')).toBe(true)
  })

  it('busca por nombre y por email sin distinguir mayúsculas', async () => {
    const porNombre = await repo.listar(eventId, { q: 'g0' }, null, 50)
    expect(porNombre.items.length).toBeGreaterThan(0)
  })

  it('el filtro combinado no cruza eventos', async () => {
    const deOtroEvento = await repo.listar(otroEventId, {}, null, 50)

    expect(deOtroEvento.items).toHaveLength(0)
  })
})
```

`★ El tercer test es el que justifica la decisión entera.` Es exactamente el bug que `OFFSET` produce y que ningún test de camino feliz detecta.

- [ ] **Step 2: Escribir el test del resumen**

```ts
describe('GuestSummaryUseCase', () => {
  it('deriva los contadores de las filas, sin columna de contador', async () => {
    // 3 confirmados, 2 pendientes, 1 rechazado
    const resumen = await caso.ejecutar(eventId)

    expect(resumen).toEqual({ total: 6, confirmed: 3, pending: 2, declined: 1 })
  })

  it('el total siempre cuadra con la suma de los estados', async () => {
    const r = await caso.ejecutar(eventId)

    expect(r.confirmed + r.pending + r.declined).toBe(r.total)
  })

  it('devuelve ceros, no undefined, para un evento sin invitados', async () => {
    expect(await caso.ejecutar(eventoVacio)).toEqual({ total: 0, confirmed: 0, pending: 0, declined: 0 })
  })
})
```

El segundo test es el invariante que el frontend ya codifica en sus `refine` de Zod, y la razón por la que no existe ninguna columna de contador: una columna se desincroniza y este test dejaría de pasar sin que nadie tocara el resumen.

- [ ] **Step 3: Ejecutar y verificar que fallan**

Run: `npx vitest run src/modules/guests`
Expected: FAIL — módulos no encontrados.

- [ ] **Step 4: Escribir el repositorio**

Núcleo de `PrismaGuestRepository.listar`:

```ts
async listar(
  eventId: string,
  filtros: GuestFilters,
  cursor: CursorValue | null,
  limite: number,
): Promise<CursorPage<Guest>> {
  const where: Prisma.GuestWhereInput = {
    eventId,
    ...(filtros.rsvp !== undefined ? { rsvp: filtros.rsvp } : {}),
    ...(filtros.group !== undefined ? { group: filtros.group } : {}),
    ...(filtros.q !== undefined
      ? {
          OR: [
            { name: { contains: filtros.q, mode: 'insensitive' } },
            { email: { contains: filtros.q, mode: 'insensitive' } },
          ],
        }
      : {}),
    // Comparación lexicográfica de la tupla (createdAt, id): "estrictamente
    // posterior al cursor". Con createdAt solo, dos invitados creados en el
    // mismo milisegundo harían que uno se perdiera entre páginas.
    ...(cursor !== null
      ? {
          OR: [
            { createdAt: { gt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { gt: cursor.id } },
          ],
        }
      : {}),
  }

  // Se pide uno de más: si viene, hay página siguiente. Evita el COUNT(*)
  // adicional, que en una tabla grande cuesta más que la propia consulta.
  const filas = await this.prisma.guest.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limite + 1,
  })

  const hayMas = filas.length > limite
  const items = hayMas ? filas.slice(0, limite) : filas
  const ultimo = items.at(-1)

  return {
    items,
    nextCursor: hayMas && ultimo !== undefined ? encodeCursor(ultimo) : null,
  }
}
```

Y el resumen, derivado:

```ts
async contarPorEstado(eventId: string): Promise<Record<RsvpStatus, number>> {
  // GROUP BY, no una columna de contador. Una columna se desincroniza en
  // cuanto alguien actualiza un RSVP por una vía que no la mantiene.
  const grupos = await this.prisma.guest.groupBy({
    by: ['rsvp'],
    where: { eventId },
    _count: { _all: true },
  })

  const base: Record<RsvpStatus, number> = { CONFIRMED: 0, PENDING: 0, DECLINED: 0 }
  for (const grupo of grupos) base[grupo.rsvp] = grupo._count._all

  return base
}
```

- [ ] **Step 5: Escribir los DTOs con Zod**

`src/modules/guests/interfaces/guest.dto.ts`:

```ts
import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

/** El límite se acota arriba: sin tope, `?limit=1000000` es una denegación gratis. */
export const listarInvitadosQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  rsvp: z.enum(['CONFIRMED', 'PENDING', 'DECLINED']).optional(),
  group: z.string().min(1).max(50).optional(),
  q: z.string().min(1).max(100).optional(),
})

export const crearInvitadoSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /**
   * OPCIONAL: se invita también por teléfono, en persona o por carta. Lo que
   * esto arrastra no está aquí sino en el envío (Tarea 12): un invitado sin
   * email no puede recibir invitación, y eso se dice, no se silencia.
   */
  email: z.email().optional(),
  group: z.string().trim().min(1).max(50),
  dietary: z.string().trim().min(1).max(200).nullable().optional(),
})

export const actualizarInvitadoSchema = crearInvitadoSchema.partial().extend({
  rsvp: z.enum(['CONFIRMED', 'PENDING', 'DECLINED']).optional(),
})

export class ListarInvitadosQueryDto extends createZodDto(listarInvitadosQuerySchema) {}
export class CrearInvitadoDto extends createZodDto(crearInvitadoSchema) {}
export class ActualizarInvitadoDto extends createZodDto(actualizarInvitadoSchema) {}
```

```bash
npm i nestjs-zod @nestjs/swagger
```

- [ ] **Step 6: Escribir el controlador**

```ts
@Controller('events/:eventId/guests')
@UseGuards(JwtAuthGuard, EventAccessGuard)
@RequireEventAccess('COUPLE', 'PLANNER')
export class GuestsController {
  // Nota deliberada: el decorador a nivel de clase excluye a VENDOR de TODO
  // este controlador. Un catering contratado no necesita los datos personales
  // de 150 personas; si algún día hace falta (restricciones alimentarias),
  // será un endpoint agregado y anonimizado, no acceso a la tabla.
}
```

Rutas: `GET /`, `GET /summary`, `POST /`, `GET /:guestId`, `PATCH /:guestId`, `DELETE /:guestId`.

`GET /summary` va declarada **antes** que `GET /:guestId`: al revés, Express casa `summary` con `:guestId` y el resumen devuelve un 404.

- [ ] **Step 7: Ejecutar y verificar que pasan**

Run: `npx vitest run src/modules/guests && npm run lint && npm run typecheck`
Expected: PASS — 10 tests.

- [ ] **Step 8: Escribir el e2e**

`test/e2e/guests.e2e.test.ts`, con los tres casos que la spec exige:

```ts
it('crea un invitado sin email', async () => {
  const { body } = await request(app.getHttpServer())
    .post(`/events/${eventId}/guests`)
    .set('Authorization', `Bearer ${pareja.accessToken}`)
    .send({ name: 'Tía Carmen', group: 'Family' })
    .expect(201)

  expect(body.email).toBeNull()
})

it('un vendor contratado NO puede listar los invitados', async () => {
  await request(app.getHttpServer())
    .get(`/events/${eventId}/guests`)
    .set('Authorization', `Bearer ${vendorBooked.accessToken}`)
    .expect(403)
})

it('un usuario sin relación con el evento recibe 404', async () => {
  await request(app.getHttpServer())
    .get(`/events/${eventId}/guests`)
    .set('Authorization', `Bearer ${extraño.accessToken}`)
    .expect(404)
})
```

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat: invitados con paginacion por cursor y resumen derivado

Cursor sobre la tupla (createdAt, id), con test explicito de que insertar
mientras se pagina no hace saltar filas: es justo el bug que OFFSET
produce. El resumen sale de un GROUP BY y no existe ninguna columna de
contador. El email del invitado es opcional."
```

---

### Task 12: Envío de invitaciones — 202, resultado por invitado y worker idempotente

**Files:**
- Create: `src/modules/guests/domain/invitation.ts`, `src/modules/guests/application/{invitation.repository.ts,send-invitations.use-case.ts,send-single-invitation.use-case.ts}`, `src/modules/guests/infrastructure/prisma-invitation.repository.ts`, `src/modules/guests/interfaces/invitation.processor.ts`
- Modify: `src/modules/guests/interfaces/guests.controller.ts`, `src/modules/guests/guests.module.ts`
- Test: `src/modules/guests/application/send-invitations.use-case.test.ts`, `src/modules/guests/interfaces/invitation.processor.test.ts`

**Interfaces:**
- Consumes: `GuestRepository` (T11), `QUEUE_PORT` (T6), `MAIL_PORT` + `renderGuestInvitation` (T5), `UnprocessableError` (T4).
- Produces:
  - ```ts
    export interface ResultadoEnvio {
      queued: Array<{ guestId: string; invitationId: string }>
      skipped: Array<{ guestId: string; reason: 'NO_EMAIL' | 'ALREADY_RESPONDED' }>
    }
    ```
  - `class SendInvitationsUseCase { ejecutar(eventId: string): Promise<ResultadoEnvio> }`
  - `class GuestHasNoEmailError extends UnprocessableError` (code `GUEST_HAS_NO_EMAIL`)
  - `generarTokenInvitacion(): { token: string; hash: string }`
  - `interface InvitationRepository { crear(datos: { guestId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }>; buscarConInvitadoYEvento(id: string): Promise<InvitacionCompleta | null>; marcarEnviada(id: string, providerMessageId: string): Promise<void>; buscarPorHash(tokenHash: string): Promise<InvitacionCompleta | null>; marcarRespondida(id: string): Promise<void>; actualizarEstadoPorMessageId(messageId: string, estado: InvitationStatus): Promise<void> }`, token `INVITATION_REPOSITORY`
  - `class InvitationProcessor` — worker de la cola `email`, job `guest-invitation`, payload `{ invitationId: string; token: string; requestId: string }`

- [ ] **Step 1: Escribir el test que falla**

`src/modules/guests/application/send-invitations.use-case.test.ts`:

```ts
describe('SendInvitationsUseCase', () => {
  let invitados: GuestRepositoryEnMemoria
  let invitaciones: InvitationRepositoryEnMemoria
  let cola: InMemoryQueueAdapter
  let caso: SendInvitationsUseCase

  beforeEach(() => {
    invitados = new GuestRepositoryEnMemoria()
    invitaciones = new InvitationRepositoryEnMemoria()
    cola = new InMemoryQueueAdapter()
    caso = new SendInvitationsUseCase(invitados, invitaciones, cola)
  })

  it('encola una invitación por cada invitado con email', async () => {
    invitados.añadir({ id: 'g1', eventId: 'ev-1', email: 'a@test.com', rsvp: 'PENDING' })
    invitados.añadir({ id: 'g2', eventId: 'ev-1', email: 'b@test.com', rsvp: 'PENDING' })

    const resultado = await caso.ejecutar('ev-1')

    expect(resultado.queued).toHaveLength(2)
    expect(resultado.skipped).toHaveLength(0)
    expect(cola.encolados).toHaveLength(2)
  })

  it('REPORTA los invitados sin email como omitidos, no los descarta en silencio', async () => {
    invitados.añadir({ id: 'g1', eventId: 'ev-1', email: 'a@test.com', rsvp: 'PENDING' })
    invitados.añadir({ id: 'g2', eventId: 'ev-1', email: null, rsvp: 'PENDING' })

    const resultado = await caso.ejecutar('ev-1')

    expect(resultado.queued.map((q) => q.guestId)).toEqual(['g1'])
    expect(resultado.skipped).toEqual([{ guestId: 'g2', reason: 'NO_EMAIL' }])
  })

  it('omite a quien ya respondió: reinvitarle es ruido', async () => {
    invitados.añadir({ id: 'g1', eventId: 'ev-1', email: 'a@test.com', rsvp: 'CONFIRMED' })

    const resultado = await caso.ejecutar('ev-1')

    expect(resultado.skipped).toEqual([{ guestId: 'g1', reason: 'ALREADY_RESPONDED' }])
  })

  it('usa un jobId derivado de la invitación, para que reintentar no duplique', async () => {
    invitados.añadir({ id: 'g1', eventId: 'ev-1', email: 'a@test.com', rsvp: 'PENDING' })

    const resultado = await caso.ejecutar('ev-1')

    expect(cola.encolados[0]?.jobId).toBe(`invitation:${resultado.queued[0]?.invitationId}`)
  })

  it('guarda sólo el HASH del token, nunca el token', async () => {
    invitados.añadir({ id: 'g1', eventId: 'ev-1', email: 'a@test.com', rsvp: 'PENDING' })

    await caso.ejecutar('ev-1')

    const guardada = invitaciones.todas()[0]
    expect(guardada?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(guardada)).not.toContain('token:')
  })

  it('un evento sin invitados devuelve listas vacías, no un error', async () => {
    expect(await caso.ejecutar('ev-vacio')).toEqual({ queued: [], skipped: [] })
  })
})
```

`★ El segundo test es el corazón de esta tarea.` La implementación tentadora —filtrar los invitados sin email antes de encolar— devuelve `202` y deja a 40 personas sin recibir nada, sin que nadie se entere. Cuando un dato opcional hace imposible una operación, el sistema tiene que **decirlo**.

- [ ] **Step 2: Ejecutar y verificar que falla**

Run: `npx vitest run src/modules/guests/application/send-invitations.use-case.test.ts`
Expected: FAIL — no existe `send-invitations.use-case`.

- [ ] **Step 3: Escribir el token de invitación**

`src/modules/guests/domain/invitation.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto'

export const DIAS_DE_VALIDEZ = 90

/**
 * Token de RSVP. Mismo criterio que el refresh token: se entrega el token en
 * claro (viaja en el enlace del correo) y se persiste sólo su hash. Si se
 * filtra la base de datos, no se obtienen enlaces válidos con los que responder
 * por otros.
 */
export function generarTokenInvitacion(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: createHash('sha256').update(token).digest('hex') }
}

export function hashDeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function caducidadInvitacion(desde = new Date()): Date {
  return new Date(desde.getTime() + DIAS_DE_VALIDEZ * 86_400_000)
}
```

- [ ] **Step 4: Escribir el caso de uso**

```ts
@Injectable()
export class SendInvitationsUseCase {
  constructor(
    @Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository,
    @Inject(INVITATION_REPOSITORY) private readonly invitaciones: InvitationRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(eventId: string, requestId = ''): Promise<ResultadoEnvio> {
    const todos = await this.invitados.listarTodos(eventId)
    const resultado: ResultadoEnvio = { queued: [], skipped: [] }

    for (const invitado of todos) {
      // Un invitado sin email NO puede recibir invitación. Se REPORTA, no se
      // filtra: quien pulsa "enviar a los 150" tiene derecho a saber que 40 no
      // van a recibir nada.
      if (invitado.email === null) {
        resultado.skipped.push({ guestId: invitado.id, reason: 'NO_EMAIL' })
        continue
      }

      if (invitado.rsvp !== 'PENDING') {
        resultado.skipped.push({ guestId: invitado.id, reason: 'ALREADY_RESPONDED' })
        continue
      }

      const { hash } = generarTokenInvitacion()
      const invitacion = await this.invitaciones.crear({
        guestId: invitado.id,
        tokenHash: hash,
        expiresAt: caducidadInvitacion(),
      })

      // jobId determinista: encolar dos veces la misma invitación deja UN job.
      await this.cola.enqueue(
        'email',
        'guest-invitation',
        { invitationId: invitacion.id, requestId },
        { jobId: `invitation:${invitacion.id}` },
      )

      resultado.queued.push({ guestId: invitado.id, invitationId: invitacion.id })
    }

    return resultado
  }
}
```

**Dónde vive el token en claro, y por qué ahí.** La tabla guarda sólo el hash, así que el token original no es recuperable — y el worker lo necesita para construir el enlace del correo. Por eso viaja **en el payload del job**: es la única copia, vive en Redis mientras dura el job y desaparece al completarse.

Dos alternativas descartadas y el motivo:
- *Guardar el token en claro en la tabla* — anula el propósito del hash: una filtración de la base de datos volvería a dar enlaces válidos con los que responder por otros.
- *Que el worker genere el token* — entonces el token cambia en cada reintento, y un reintento tras un envío ya entregado invalidaría el enlace que el invitado acaba de recibir.

Por tanto: `invitaciones.crear(...)` devuelve `{ id: string; token: string }` —el token en claro sólo hacia el caso de uso, nunca persistido— y el payload del job es `{ invitationId: string; token: string; requestId: string }`.

- [ ] **Step 5: Ejecutar y verificar que pasa**

Run: `npx vitest run src/modules/guests/application/send-invitations.use-case.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Escribir el worker**

`src/modules/guests/interfaces/invitation.processor.ts`:

```ts
@Processor('email')
export class InvitationProcessor extends WorkerHost {
  async process(job: Job<{ invitationId: string; token: string; requestId: string }>): Promise<void> {
    const invitacion = await this.invitaciones.buscarConInvitadoYEvento(job.data.invitationId)

    // La invitación pudo borrarse entre el encolado y el procesado. No es un
    // error: se descarta el job sin reintentar, porque reintentar no la va a
    // hacer aparecer.
    if (invitacion === null) return
    if (invitacion.status !== 'QUEUED') return // ya enviada: reintento tardío

    const { html, text } = await renderGuestInvitation({
      guestName: invitacion.guest.name,
      eventName: invitacion.event.name,
      weddingDate: formatearFecha(invitacion.event.weddingDate),
      rsvpUrl: `${this.env.APP_URL}/rsvp/${job.data.token}`,
    })

    const { providerMessageId } = await this.mail.send({
      to: invitacion.guest.email,
      subject: `You are invited to ${invitacion.event.name}`,
      html,
      text,
      tags: { eventId: invitacion.event.id, invitationId: invitacion.id },
    })

    // SENT y el id del proveedor en la misma escritura: el webhook (Tarea 13)
    // casa por providerMessageId, así que si esto falla el webhook llega a una
    // invitación que no sabe reconocer.
    await this.invitaciones.marcarEnviada(invitacion.id, providerMessageId)
  }
}
```

`src/modules/guests/interfaces/invitation.processor.test.ts`:

```ts
it('no reintenta cuando la invitación ya no existe', async () => {
  await procesador.process(jobFalso({ invitationId: 'borrada', token: 't' }))

  expect(mail.enviados).toHaveLength(0)
})

it('no reenvía una invitación que ya está SENT', async () => {
  invitaciones.añadir({ id: 'inv-1', status: 'SENT' })

  await procesador.process(jobFalso({ invitationId: 'inv-1', token: 't' }))

  expect(mail.enviados).toHaveLength(0)
})

it('propaga el fallo del proveedor para que BullMQ reintente', async () => {
  invitaciones.añadir({ id: 'inv-1', status: 'QUEUED' })
  mail.fallarProximoEnvio(new Error('proveedor caído'))

  await expect(procesador.process(jobFalso({ invitationId: 'inv-1', token: 't' }))).rejects.toThrow()
})

it('guarda el id del proveedor al enviar, para que el webhook pueda casarlo', async () => {
  invitaciones.añadir({ id: 'inv-1', status: 'QUEUED' })

  await procesador.process(jobFalso({ invitationId: 'inv-1', token: 't' }))

  expect(invitaciones.buscar('inv-1')?.resendMessageId).toMatch(/^fake-/)
})
```

El tercer test es sutil y se equivoca fácil: **tragarse el error del proveedor rompe los reintentos.** Si el worker captura y registra en vez de lanzar, BullMQ marca el job como completado y la invitación se queda en `QUEUED` para siempre.

- [ ] **Step 7: Enganchar los endpoints**

```
POST /events/:eventId/guests/invitations              → 202 + ResultadoEnvio
POST /events/:eventId/guests/:guestId/invitation      → 202, o 422 GUEST_HAS_NO_EMAIL
```

Ambos con `@RequireEventAccess('COUPLE', 'PLANNER')`. `202` y no `201`: la petición **acepta** el trabajo, no lo termina.

- [ ] **Step 8: Verificar y commitear**

Run: `npm run lint && npm run typecheck && npm test`

```bash
git add .
git commit -m "feat: envio de invitaciones por cola con resultado por invitado

El envio masivo devuelve 202 con encolados y omitidos: filtrar en silencio
a los invitados sin email dejaria a 40 personas sin recibir nada sin que
nadie se entere. El worker propaga los fallos del proveedor en vez de
tragarselos, que es lo unico que hace funcionar los reintentos."
```

---

### Task 13: Webhook de Resend con verificación de firma

**Files:**
- Create: `src/modules/guests/interfaces/resend-webhook.controller.ts`, `src/modules/guests/application/handle-delivery-event.use-case.ts`, `src/modules/guests/infrastructure/svix-signature.verifier.ts`
- Modify: `src/main.ts` (body crudo en la ruta del webhook)
- Test: `src/modules/guests/application/handle-delivery-event.use-case.test.ts`, `test/e2e/resend-webhook.e2e.test.ts`

**Interfaces:**
- Consumes: `InvitationRepository` (T12), `ENV` (T1).
- Produces:
  - `class FirmaInvalidaError extends DomainError` con `httpStatus = 401` y `code = 'INVALID_SIGNATURE'` (se declara en `src/modules/guests/domain/guest-errors.ts`)
  - `class SvixSignatureVerifier { verificar(cuerpoCrudo: Buffer, cabeceras: Record<string, string>): unknown }` — lanza `FirmaInvalidaError`
  - `class HandleDeliveryEventUseCase { ejecutar(evento: { type: string; messageId: string }): Promise<void> }`
  - `mapearEstadoResend(type: string): InvitationStatus | null`

- [ ] **Step 1: Instalar**

```bash
npm i svix
```

- [ ] **Step 2: Escribir el test que falla**

```ts
describe('HandleDeliveryEventUseCase', () => {
  it('marca DELIVERED cuando el correo se entrega', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'SENT' })

    await caso.ejecutar({ type: 'email.delivered', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('DELIVERED')
  })

  it('marca BOUNCED cuando rebota', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'SENT' })

    await caso.ejecutar({ type: 'email.bounced', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('BOUNCED')
  })

  it('es idempotente: el mismo evento dos veces no cambia nada', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'SENT' })

    await caso.ejecutar({ type: 'email.delivered', messageId: 'msg-1' })
    await caso.ejecutar({ type: 'email.delivered', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('DELIVERED')
  })

  it('NO retrocede el estado: un delivered tardío no pisa un RESPONDED', async () => {
    // Los webhooks llegan desordenados. Si `delivered` sobrescribe sin mirar,
    // un invitado que ya respondió vuelve a aparecer como pendiente.
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'RESPONDED' })

    await caso.ejecutar({ type: 'email.delivered', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('RESPONDED')
  })

  it('ignora un messageId desconocido sin lanzar', async () => {
    // Devolver 500 hace que Resend reintente indefinidamente un evento que
    // nunca vamos a poder casar.
    await expect(caso.ejecutar({ type: 'email.delivered', messageId: 'ajeno' })).resolves.toBeUndefined()
  })

  it('ignora tipos de evento que no nos interesan', async () => {
    invitaciones.añadir({ id: 'inv-1', resendMessageId: 'msg-1', status: 'SENT' })

    await caso.ejecutar({ type: 'email.opened', messageId: 'msg-1' })

    expect(invitaciones.buscar('inv-1')?.status).toBe('SENT')
  })
})
```

El cuarto test es el que se olvida siempre: los webhooks **no llegan en orden**.

- [ ] **Step 3: Ejecutar, verificar que falla, implementar**

El orden de estados se codifica explícitamente:

```ts
/**
 * Los webhooks llegan desordenados, así que el estado sólo AVANZA. Un
 * `delivered` que llega tarde no puede pisar un `RESPONDED` ya alcanzado.
 */
const ORDEN: Record<InvitationStatus, number> = {
  QUEUED: 0,
  SENT: 1,
  DELIVERED: 2,
  BOUNCED: 3,
  COMPLAINED: 3,
  RESPONDED: 4,
}

export function mapearEstadoResend(type: string): InvitationStatus | null {
  switch (type) {
    case 'email.delivered':
      return 'DELIVERED'
    case 'email.bounced':
      return 'BOUNCED'
    case 'email.complained':
      return 'COMPLAINED'
    default:
      return null // opened, clicked, sent: no cambian nuestro estado
  }
}
```

- [ ] **Step 4: Escribir el verificador de firma**

```ts
@Injectable()
export class SvixSignatureVerifier {
  private readonly webhook: Webhook

  constructor(@Inject(ENV) env: Env) {
    if (env.RESEND_WEBHOOK_SECRET === undefined) {
      throw new Error('El webhook de Resend requiere RESEND_WEBHOOK_SECRET')
    }
    this.webhook = new Webhook(env.RESEND_WEBHOOK_SECRET)
  }

  /**
   * Se verifica sobre el cuerpo CRUDO, antes de parsear: la firma cubre los
   * bytes exactos, y `JSON.parse` + `JSON.stringify` los cambia. Por eso la
   * ruta necesita `express.raw()` en main.ts.
   */
  verificar(cuerpoCrudo: Buffer, cabeceras: Record<string, string>): unknown {
    try {
      return this.webhook.verify(cuerpoCrudo.toString('utf8'), cabeceras)
    } catch {
      throw new FirmaInvalidaError()
    }
  }
}
```

- [ ] **Step 5: Escribir el e2e que prueba el rechazo**

```ts
it('rechaza un webhook con firma inválida sin tocar la base de datos', async () => {
  await request(app.getHttpServer())
    .post('/webhooks/resend')
    .set('svix-id', 'msg_falso')
    .set('svix-timestamp', String(Math.floor(Date.now() / 1000)))
    .set('svix-signature', 'v1,firmainventada')
    .send({ type: 'email.bounced', data: { email_id: mensajeReal } })
    .expect(401)

  // Lo que de verdad importa: el estado NO cambió.
  const invitacion = await prisma.guestInvitation.findUnique({ where: { id: invitacionId } })
  expect(invitacion?.status).toBe('SENT')
})
```

`★ Sin este endpoint verificado, cualquiera en internet puede marcar como rebotadas las 150 invitaciones de una boda.` Un webhook es un endpoint de escritura sin autenticación de usuario: la firma **es** su autenticación.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: webhook de Resend con firma verificada y estados monotonos

La firma se verifica sobre el cuerpo crudo antes de parsear. El estado de
la invitacion solo avanza: los webhooks llegan desordenados y un delivered
tardio no puede pisar un RESPONDED."
```

---

### Task 14: RSVP público — el único endpoint sin sesión

**Files:**
- Create: `src/modules/guests/application/{get-rsvp.use-case.ts,submit-rsvp.use-case.ts}`, `src/modules/guests/interfaces/{rsvp.controller.ts,rsvp.dto.ts}`
- Modify: `src/app.module.ts` (ThrottlerModule con Redis)
- Test: `src/modules/guests/application/submit-rsvp.use-case.test.ts`, `test/e2e/rsvp.e2e.test.ts`

**Interfaces:**
- Consumes: `InvitationRepository` (T12), `GuestRepository` (T11), `PrismaService` (T3).
- **Define aquí** (se implementan en T15, y hasta entonces se usan los dobles): `interface NotificationPort { crearParaMiembros(eventId: string, tipo: string, payload: unknown): Promise<void> }` con token `NOTIFICATION_PORT`, e `interface RealtimePort` con token `REALTIME_PORT`. El orden importa: esta tarea define los puertos que necesita y la siguiente aporta los adaptadores; al revés, T14 no se podría probar sin T15.
- Produces:
  - `class GetRsvpUseCase { ejecutar(token: string): Promise<VistaPublicaRsvp> }`
  - `interface VistaPublicaRsvp { guestName: string; eventName: string; weddingDate: string; rsvp: RsvpStatus; dietary: string | null }`
  - `class SubmitRsvpUseCase { ejecutar(token: string, respuesta: { rsvp: 'CONFIRMED' | 'DECLINED'; dietary?: string | null }): Promise<void> }`
  - `class InvitacionNoValidaError extends NotFoundError` (code `INVITATION_INVALID`)

- [ ] **Step 1: Instalar el rate limiting**

```bash
npm i @nestjs/throttler @nest-lab/throttler-storage-redis
```

- [ ] **Step 2: Escribir el test que falla**

```ts
describe('SubmitRsvpUseCase', () => {
  it('actualiza el invitado y marca la invitación como respondida', async () => {
    const { token } = await prepararInvitacionValida()

    await caso.ejecutar(token, { rsvp: 'CONFIRMED', dietary: 'Vegan' })

    expect(invitados.buscar('g1')?.rsvp).toBe('CONFIRMED')
    expect(invitados.buscar('g1')?.dietary).toBe('Vegan')
    expect(invitaciones.buscar('inv-1')?.status).toBe('RESPONDED')
  })

  it('rechaza un token que ya se usó', async () => {
    const { token } = await prepararInvitacionValida()
    await caso.ejecutar(token, { rsvp: 'CONFIRMED' })

    await expect(caso.ejecutar(token, { rsvp: 'DECLINED' })).rejects.toThrow(InvitacionNoValidaError)
  })

  it('rechaza un token caducado', async () => {
    const { token } = await prepararInvitacion({ expiresAt: new Date(Date.now() - 1000) })

    await expect(caso.ejecutar(token, { rsvp: 'CONFIRMED' })).rejects.toThrow(InvitacionNoValidaError)
  })

  it('devuelve el MISMO error para token inexistente, usado y caducado', async () => {
    // Distinguirlos le dice a quien prueba tokens al azar cuándo ha acertado
    // uno real. Con un solo error, no aprende nada.
    const inexistente = await capturarError(() => caso.ejecutar('inventado', { rsvp: 'CONFIRMED' }))
    const caducado = await capturarError(() => caso.ejecutar(tokenCaducado, { rsvp: 'CONFIRMED' }))

    expect(inexistente.code).toBe(caducado.code)
    expect(inexistente.message).toBe(caducado.message)
  })

  it('crea una notificación por cada miembro del evento', async () => {
    const { token } = await prepararInvitacionValida()

    await caso.ejecutar(token, { rsvp: 'CONFIRMED' })

    expect(notificaciones.creadas.map((n) => n.userId).sort()).toEqual(['user-pareja', 'user-planner'])
  })

  it('persiste ANTES de emitir: el socket nunca es fuente de verdad', async () => {
    const { token } = await prepararInvitacionValida()
    tiempoReal.fallarProximaEmision(new Error('redis caído'))

    // Que el fan-out falle no puede perder la respuesta del invitado.
    await caso.ejecutar(token, { rsvp: 'CONFIRMED' })

    expect(invitados.buscar('g1')?.rsvp).toBe('CONFIRMED')
    expect(notificaciones.creadas).toHaveLength(2)
  })
})
```

`★ El último test codifica la regla central del diseño de tiempo real.` Si la emisión ocurriera antes de persistir, o si su fallo abortara la transacción, una caída de Redis haría desaparecer la respuesta de un invitado. El socket es una optimización de latencia sobre un estado que ya existe.

- [ ] **Step 3: Implementar el caso de uso**

Todo en **una transacción**: actualizar `Guest`, marcar la invitación `RESPONDED`, crear las `Notification`. Fuera de la transacción y **después** de que confirme, encolar el job de `notifications`.

`GetRsvpUseCase` devuelve **el mínimo**: nombre del invitado, nombre y fecha del evento, y su estado actual. Nunca la lista de invitados, ni el email de nadie, ni el id del evento — quien tiene el token no está autenticado.

- [ ] **Step 4: Escribir el controlador con su propio rate limiting**

```ts
@Controller('rsvp')
@SkipThrottle(false)
export class RsvpController {
  /**
   * Los DOS únicos endpoints sin JWT del backend. Por eso llevan su propio
   * límite, más estricto que el global: un token de 32 bytes no se acierta por
   * fuerza bruta, pero el límite corta el sondeo antes de que genere carga.
   */
  @Get(':token')
  @Throttle({ rsvp: { limit: 20, ttl: 60_000 } })
  obtener(@Param('token') token: string): Promise<VistaPublicaRsvp> { /* ... */ }

  @Post(':token')
  @Throttle({ rsvp: { limit: 5, ttl: 60_000 } })
  @HttpCode(204)
  responder(@Param('token') token: string, @Body() dto: ResponderRsvpDto): Promise<void> { /* ... */ }
}
```

- [ ] **Step 5: Configurar el throttler global con almacenamiento en Redis**

En `app.module.ts`:

```ts
ThrottlerModule.forRootAsync({
  inject: [ENV],
  useFactory: (env: Env) => ({
    // En Redis, no en memoria: con varias instancias, un límite por proceso
    // multiplica el límite real por el número de procesos.
    storage: new ThrottlerStorageRedisService(env.REDIS_URL),
    throttlers: [{ name: 'global', ttl: 60_000, limit: 120 }],
  }),
})
```

Y en `auth`: `@Throttle({ login: { limit: 5, ttl: 900_000 } })` sobre `POST /auth/login`, con clave compuesta por IP **y** por email — limitar sólo por IP deja pasar el ataque distribuido contra una cuenta concreta, y limitar sólo por cuenta permite bloquear a un usuario legítimo a propósito.

- [ ] **Step 6: Verificar y commitear**

```bash
git add .
git commit -m "feat: RSVP publico con token de un solo uso y rate limiting propio

Token inexistente, usado y caducado devuelven el mismo error: distinguirlos
le dice a quien prueba tokens cuando ha acertado. La vista publica expone
el minimo, porque quien la abre no esta autenticado. El rate limiting vive
en Redis: en memoria, N instancias multiplican el limite por N."
```

---

### Task 15: Notificaciones y tiempo real

**Files:**
- Create: `src/modules/notifications/application/{notification.repository.ts,realtime.port.ts,list-notifications.use-case.ts,mark-read.use-case.ts}`, `src/modules/notifications/infrastructure/{prisma-notification.repository.ts,socketio-realtime.adapter.ts}`, `src/modules/notifications/interfaces/{notifications.gateway.ts,notifications.controller.ts,notification.processor.ts}`, `src/modules/notifications/notifications.module.ts`
- Test: `src/modules/notifications/interfaces/notifications.gateway.test.ts`, `test/e2e/realtime.e2e.test.ts`

**Interfaces:**
- Consumes: `TokenService` (T8), `EventAccessService` (T9), `QUEUE_PORT` (T6), `PrismaService` (T3).
- Produces:
  - `interface RealtimePort { emitirAEvento(eventId: string, tipo: string, payload: unknown): Promise<void>; emitirAUsuario(userId: string, tipo: string, payload: unknown): Promise<void> }`, token `REALTIME_PORT`
  - `class NotificationsGateway implements OnGatewayConnection` — namespace `/realtime`
  - Eventos emitidos: `guest.rsvp.updated`, `guest.invitation.status`, `notification.created`

- [ ] **Step 1: Instalar**

```bash
npm i @nestjs/websockets @nestjs/platform-socket.io socket.io @socket.io/redis-adapter
npm i -D socket.io-client
```

- [ ] **Step 2: Escribir el test que falla**

```ts
describe('NotificationsGateway', () => {
  it('rechaza una conexión sin token', async () => {
    const socket = conectar({ auth: {} })

    await expect(esperarConexion(socket)).rejects.toThrow(/no autorizado/i)
  })

  it('rechaza un token inválido', async () => {
    const socket = conectar({ auth: { token: 'inventado' } })

    await expect(esperarConexion(socket)).rejects.toThrow(/no autorizado/i)
  })

  it('acepta un token válido y une al usuario a su sala personal', async () => {
    const socket = conectar({ auth: { token: accessTokenDePareja } })

    await esperarConexion(socket)
    expect(await salasDe(socket)).toContain(`user:${parejaId}`)
  })

  it('deja entrar a la sala de un evento sólo con acceso', async () => {
    const socket = await conectarComo(pareja)

    const respuesta = await emitirYEsperar(socket, 'join', { eventId })

    expect(respuesta).toEqual({ ok: true })
  })

  it('NIEGA la sala de un evento ajeno, con el mismo criterio que el REST', async () => {
    const socket = await conectarComo(extraño)

    const respuesta = await emitirYEsperar(socket, 'join', { eventId })

    expect(respuesta).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('un vendor contratado entra en la sala del evento', async () => {
    const socket = await conectarComo(vendorBooked)

    expect(await emitirYEsperar(socket, 'join', { eventId })).toEqual({ ok: true })
  })
})
```

El quinto test es el que importa: **el gateway usa el mismo `EventAccessService` que el REST**, así que no puede existir un permiso que valga en socket y no en HTTP.

- [ ] **Step 3: Implementar el gateway**

```ts
@WebSocketGateway({ namespace: '/realtime', cors: { origin: false } })
export class NotificationsGateway implements OnGatewayConnection {
  async handleConnection(socket: Socket): Promise<void> {
    try {
      // El MISMO access JWT que el REST. Un canal de tiempo real con su propia
      // autenticación acaba teniendo su propia política de permisos, y es
      // cuestión de tiempo que divergan.
      const { sub } = this.tokens.verificarAccess(String(socket.handshake.auth.token ?? ''))
      socket.data.userId = sub
      await socket.join(`user:${sub}`)
    } catch {
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'No autorizado' })
      socket.disconnect(true)
    }
  }

  @SubscribeMessage('join')
  async unirse(
    @ConnectedSocket() socket: Socket,
    @MessageBody() datos: { eventId: string },
  ): Promise<{ ok: boolean; code?: string }> {
    const usuario = await this.usuarios.findById(String(socket.data.userId))
    if (usuario === null) return { ok: false, code: 'NOT_FOUND' }

    const acceso = await this.accesoAEventos.resolve(usuario.id, usuario.systemRole, datos.eventId)
    // Mismo criterio que el guard HTTP: sin acceso, el evento "no existe".
    if (acceso.kind === 'none') return { ok: false, code: 'NOT_FOUND' }

    await socket.join(`event:${datos.eventId}`)
    return { ok: true }
  }
}
```

- [ ] **Step 4: Configurar el adapter de Redis**

En `main.ts`, antes de `listen`:

```ts
// Sin este adapter, un usuario conectado a la instancia B nunca recibe lo que
// emite la instancia A. Y quien emite aquí es el WORKER, que es otro proceso
// distinto del HTTP: sin Redis, el fan-out no sale de su propio proceso.
const pubClient = createClient({ url: env.REDIS_URL })
const subClient = pubClient.duplicate()
await Promise.all([pubClient.connect(), subClient.connect()])
app.useWebSocketAdapter(new RedisIoAdapter(app, pubClient, subClient))
```

- [ ] **Step 5: Escribir el e2e del flujo completo**

`test/e2e/realtime.e2e.test.ts`:

```ts
it('responder un RSVP notifica a la pareja por socket y queda persistido', async () => {
  const socket = await conectarComo(pareja)
  await emitirYEsperar(socket, 'join', { eventId })

  const recibido = esperarEvento(socket, 'guest.rsvp.updated')

  await request(app.getHttpServer()).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(204)

  expect(await recibido).toMatchObject({ guestId, rsvp: 'CONFIRMED' })
})

it('un cliente desconectado recupera por REST lo que se perdió', async () => {
  // La propiedad que define el diseño: el socket es latencia, no el canal.
  await request(app.getHttpServer()).post(`/rsvp/${token}`).send({ rsvp: 'CONFIRMED' }).expect(204)

  const { body } = await request(app.getHttpServer())
    .get(`/events/${eventId}/notifications`)
    .set('Authorization', `Bearer ${pareja.accessToken}`)
    .expect(200)

  expect(body.items).toContainEqual(expect.objectContaining({ type: 'guest.rsvp.updated' }))
})
```

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: notificaciones persistidas y tiempo real sobre Socket.IO

El gateway autoriza con el MISMO EventAccessService que el REST, asi que
los permisos no pueden divergir. Toda emision tiene detras una
Notification persistida y recuperable por REST: hay test de que un cliente
desconectado no pierde nada. Adapter de Redis porque quien emite es el
worker, otro proceso distinto del HTTP."
```

---

### Task 16: Composición final — arranque endurecido, salud, OpenAPI y CI

**Files:**
- Create: `src/main.ts`, `src/app.module.ts`, `src/modules/health/health.controller.ts`, `.github/workflows/ci.yml`, `README.md`
- Test: `test/e2e/health.e2e.test.ts`, `test/e2e/security-headers.e2e.test.ts`

**Interfaces:**
- Consumes: todos los módulos anteriores.
- Produces: la aplicación ejecutable y el gate de CI.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
describe('endurecimiento del arranque', () => {
  it('no revela el servidor en las cabeceras', async () => {
    const { headers } = await request(app.getHttpServer()).get('/health').expect(200)

    expect(headers['x-powered-by']).toBeUndefined()
    expect(headers['x-content-type-options']).toBe('nosniff')
  })

  it('rechaza un origen que no está en la allowlist', async () => {
    const { headers } = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://sitio-malicioso.test')

    expect(headers['access-control-allow-origin']).toBeUndefined()
  })

  it('rechaza un cuerpo desmesurado antes de procesarlo', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ fullName: 'a'.repeat(2_000_000), email: 'a@b.com', password: 'x'.repeat(12) })
      .expect(413)
  })

  it('/health/ready falla si la base de datos no responde', async () => {
    await pararPostgres()

    await request(app.getHttpServer()).get('/health/ready').expect(503)
  })

  it('/health responde aunque la base de datos esté caída', async () => {
    // Liveness y readiness son preguntas distintas: confundirlas hace que el
    // orquestador MATE el proceso durante un incidente de base de datos, que
    // es exactamente cuando no quieres reiniciarlo todo.
    await pararPostgres()

    await request(app.getHttpServer()).get('/health').expect(200)
  })

  it('propaga el x-request-id entrante', async () => {
    const { headers } = await request(app.getHttpServer())
      .get('/health')
      .set('x-request-id', 'trazable-1')

    expect(headers['x-request-id']).toBe('trazable-1')
  })
})
```

- [ ] **Step 2: Escribir `main.ts`**

```ts
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  const env = app.get<Env>(ENV)

  app.enableShutdownHooks() // cierra Prisma, Redis y las colas al recibir SIGTERM

  app.use(helmet())
  app.use(cookieParser())
  app.use(express.json({ limit: '256kb' }))
  // El webhook necesita los BYTES EXACTOS: la firma cubre el cuerpo crudo y
  // JSON.parse + stringify los altera. Ver Tarea 13.
  app.use('/webhooks/resend', express.raw({ type: 'application/json', limit: '256kb' }))

  const origenes = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '')
  // Allowlist explícita, nunca `*`: con credenciales, `*` ni siquiera es legal,
  // y sin ellas sigue abriendo la API a cualquier página.
  app.enableCors({ origin: origenes, credentials: true })

  app.useGlobalPipes(new ZodValidationPipe())
  app.useGlobalFilters(new DomainExceptionFilter())

  const documento = SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('Wedding Planner API')
    .setVersion('1.0')
    .addBearerAuth()
    .build())
  SwaggerModule.setup('docs', app, documento, { jsonDocumentUrl: 'openapi.json' })

  await app.listen(env.PORT)
}
```

- [ ] **Step 3: Escribir el health**

```ts
@Controller('health')
export class HealthController {
  /** Liveness: ¿el proceso está vivo? No toca dependencias a propósito. */
  @Get()
  vivo(): { status: 'ok' } {
    return { status: 'ok' }
  }

  /**
   * Readiness: ¿puede atender tráfico? Aquí SÍ se comprueban las dependencias.
   * La distinción importa: si liveness fallara con la base de datos caída, el
   * orquestador reiniciaría el proceso en bucle durante el incidente.
   */
  @Get('ready')
  async listo(): Promise<{ status: string; checks: Record<string, boolean> }> {
    const [db, redis] = await Promise.all([this.comprobarDb(), this.comprobarRedis()])

    if (!db || !redis) throw new ServiceUnavailableException({ checks: { db, redis } })
    return { status: 'ok', checks: { db, redis } }
  }
}
```

- [ ] **Step 4: Escribir el CI**

`.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]

jobs:
  verificar:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx prisma generate

      - name: Tipos
        run: npm run typecheck

      - name: Arquitectura y estilo
        run: npm run lint

      # Falla si alguien cambió schema.prisma sin generar la migración. Sin
      # esto, el esquema y las migraciones divergen en silencio y el error
      # aparece en el primer despliegue.
      - name: Migraciones al día
        run: npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code
        env:
          DATABASE_URL: postgresql://wp:wp@localhost:5432/wp

      # Testcontainers necesita Docker, que el runner ya trae.
      - name: Tests
        run: npm test

      - run: npm run build
```

- [ ] **Step 5: Verificar la suite completa**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: los cuatro en verde. Todos los criterios de aceptación de la §14 de la spec deben estar cubiertos por algún test.

- [ ] **Step 6: Escribir el README**

Cubrir: requisitos (Node 22, Docker), arranque (`docker compose up -d`, `cp .env.example .env`, `npx prisma migrate dev`, `npm run dev`), el mapa de capas y la regla de dependencia, cómo correr cada nivel de tests, y un puntero a la spec.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: composicion final, salud, OpenAPI y CI

Liveness y readiness separados: si liveness comprobara la base de datos,
el orquestador reiniciaria el proceso en bucle justo durante un incidente
de base de datos. CI comprueba ademas que las migraciones no han divergido
del schema, que es un error que si no solo aparece al desplegar."
```

---

## Cobertura de la spec

| Sección de la spec | Tarea(s) |
|---|---|
| §3 Decisiones (stack) | 1, 3 |
| §4.1 Estructura por módulo | 1, y todas |
| §4.2 Regla de dependencia como gate | 2 |
| §5 Modelo de datos | 3 |
| §5.1 Vendor no es membresía | 3, 9, 10 |
| §5.2 Vendors externos (CHECK XOR) | 3, 10 |
| §5.3 Agregados derivados | 11 |
| §5.4 Email opcional del invitado | 3, 11, 12 |
| §6 Autorización en dos ejes, 404 vs 403 | 9 |
| §7 El invitado no tiene cuenta | 12, 14 |
| §8 API (paginación por cursor) | 4, 8, 9, 10, 11, 12, 13, 14, 15 |
| §9 Flujo invitación → RSVP → notificación | 12, 13, 14, 15 |
| §9.1 Idempotencia por jobId | 6, 12 |
| §9.2 El socket no es fuente de verdad | 14, 15 |
| §10.1 Colas BullMQ | 6 |
| §10.2 Correo Resend | 5, 13 |
| §10.3 Tiempo real Socket.IO | 15 |
| §10.4 Ficheros R2 | — (decidido, no se implementa en esta entrega) |
| §11 Seguridad | 2, 7, 8, 13, 14, 16 |
| §12 Testing y CI | todas + 16 |
| §13 Observabilidad | 4, 16 |
| §14 Criterios de aceptación 1–15 | 2, 8, 9, 11, 12, 13, 14, 16 |
