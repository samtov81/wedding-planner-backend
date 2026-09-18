# wedding-planner-backend

API del Wedding Planner: eventos, miembros, proveedores, invitados, RSVP público
por enlace, correo con Resend y notificaciones en tiempo real.

NestJS 11 · Clean Architecture por módulo · Prisma 6 / PostgreSQL 16 ·
Redis 7 / BullMQ · Socket.IO · Zod · pino.

## Requisitos

- Node **22.12 o superior** (la versión de CI está en `.nvmrc`).
- Docker: para Postgres y Redis en local (`docker-compose.yml`) y para los
  tests, que levantan los suyos con Testcontainers.

## Arranque en local

```bash
docker compose up -d          # Postgres 16 y Redis 7
cp .env.example .env          # tal cual sirve para local
npm ci
npx prisma migrate dev        # aplica las migraciones y genera el cliente
npm run dev                   # compila y arranca con .env
```

La API queda en `http://localhost:3000`:

- `GET /health` — liveness: el proceso está vivo. No toca dependencias.
- `GET /health/ready` — readiness: Postgres y Redis responden (503 si no).
- `GET /docs` — Swagger UI; el documento en `GET /openapi.json`.

En producción: `npm run build` y `npm start` (`node dist/main.js`), con las
variables en el entorno (no se lee ningún `.env`).

## Variables de entorno

Las valida `src/config/env.schema.ts` al arrancar: si falta una o está mal, el
proceso no arranca y lo dice. `.env.example` las lista todas (un test lo
comprueba).

| Variable | Obligatoria | Qué es |
|---|---|---|
| `DATABASE_URL` | sí | `postgresql://…` |
| `REDIS_URL` | sí | `redis://…` o `rediss://…` |
| `JWT_ACCESS_SECRET` | sí | Firma de los access tokens, 32 caracteres o más. |
| `APP_URL` | sí | Origen del frontend: base de los enlaces del RSVP y siempre dentro de la allowlist de CORS. |
| `NODE_ENV` | no | `development` (defecto), `test` o `production`. |
| `PORT` | no | 3000 por defecto. |
| `JWT_ACCESS_TTL` | no | `15m` por defecto. |
| `REFRESH_TTL_DAYS` | no | 30 por defecto. |
| `MAIL_DRIVER` | no | `fake` (defecto: escribe en `.mail-outbox/`) o `resend`. |
| `MAIL_FROM` | no | Remitente de los correos. |
| `RESEND_API_KEY` | con `resend` | Clave de la API de Resend. |
| `RESEND_WEBHOOK_SECRET` | con `resend` | Secreto de firma del webhook (`whsec_<base64>`). |
| `CORS_ORIGINS` | no | Orígenes adicionales a `APP_URL`, separados por comas. Nunca `*`. La misma lista vale para HTTP y Socket.IO. |
| `TRUST_PROXY` | detrás de un proxy | De dónde sale la IP del cliente, que es la clave de los límites de ritmo. Vacío sin proxy; `1` detrás de un balanceador; o las IPs/subredes de los proxies. `true` se rechaza. |
| `LOG_LEVEL` | no | Nivel de pino; `info` por defecto (`silent` en test). |

`TRUST_PROXY` importa: detrás de un balanceador sin él, todos los invitados
comparten la IP del balanceador y la boda entera se queda con 5 respuestas de
RSVP por minuto.

## Arquitectura

Cada módulo de `src/modules/<módulo>/` tiene cuatro capas:

```
domain/          entidades y reglas puras: no importa nada externo (sí node:*)
application/     casos de uso y los PUERTOS que necesitan; sólo mira a domain/
infrastructure/  adaptadores de esos puertos (Prisma, BullMQ, Resend, Redis…)
interfaces/      controladores HTTP, gateways de socket y workers de cola
```

La regla de dependencia es un gate, no una convención: `npm run lint` corre
dependency-cruiser (`.dependency-cruiser.cjs`) y falla si `domain/` importa
algo externo, si `application/` importa un adaptador, si un módulo toca el
`infrastructure/` o el `domain/` de otro, o si hay un ciclo.

Lo transversal vive en `src/shared/` (errores de dominio, filtro de
excepciones, límites de ritmo, request id, logs) y `src/config/` (entorno). El
arranque está en `src/main.ts` y `src/configurar-app.ts`.

## Tests

```bash
npm test               # todo: unitarios, integración y e2e (necesita Docker)
npx vitest run src/modules/guests            # un directorio
npx vitest run test/e2e/rsvp.e2e.test.ts     # un fichero
npm run test:smoke     # compila y arranca dist/main.js con node a secas
```

- **Unitarios** (`src/**/*.test.ts`): casos de uso contra dobles en memoria.
- **Integración** (`src/**/infrastructure/*.test.ts`): repositorios y colas
  contra Postgres y Redis reales en Testcontainers. Nunca SQLite.
- **E2E** (`test/e2e/`): la app entera por HTTP y Socket.IO, arrancada con la
  misma `configurarApp` que `main.ts`.
- **Arquitectura** (`test/architecture/`): la regla de dependencia.
- **Humo** (`test/smoke/`): el build compilado arrancado con `node`, fuera del
  resolver de Vitest.

Los tests nunca usan servicios del host: cada fichero levanta sus contenedores.

## Comprobaciones (lo que corre CI)

```bash
npm run typecheck
npm run lint           # dependency-cruiser + ESLint
npx prettier --check .
npm test
npm run build
npm run test:smoke
```

CI (`.github/workflows/ci.yml`) además comprueba que las migraciones no han
divergido de `prisma/schema.prisma`.

## Documentación

La especificación y el plan de implementación están en `docs/superpowers/`.
