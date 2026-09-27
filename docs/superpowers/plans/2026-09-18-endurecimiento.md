# Bloque A — endurecimiento · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar la rama `worktree-backend-nucleo-invitados` lista para producción: RSVP modificable con plazo, suite estable, seguimientos de seguridad cerrados y gates sin ruido.

**Architecture:** Cambios sobre el código existente, respetando la Clean Architecture por módulo que ya impone dependency-cruiser. La única migración es `Event.rsvpDeadlineDays`. Nada de funcionalidad de cuentas (eso es el bloque B).

**Tech Stack:** Node ≥22.12 · TypeScript estricto · NestJS 11 · Prisma 6.19 · PostgreSQL 16 · Redis 7 · BullMQ · Socket.IO 4 · Zod 4 · Vitest 3 + Testcontainers + supertest · pino

**Spec:** `docs/superpowers/specs/2026-09-18-endurecimiento-design.md` (esta tanda) sobre `docs/superpowers/specs/2026-09-17-backend-nucleo-invitados-design.md` (la base).

## Global Constraints

- **Regla de dependencia** (dependency-cruiser en `npm run lint`): `domain/` no importa nada externo salvo `node:`; `application/` sólo `domain/`; `infrastructure/` e `interfaces/` hacia dentro; un módulo no importa el `infrastructure/` ni el `domain/` de otro.
- **TypeScript estricto agresivo**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`.
- **Idioma**: `describe`, nombres de test, comentarios y docblocks en español; identificadores, rutas, códigos de error y strings de API en inglés.
- **Toda entrada validada con Zod** (con `validarCon` de `src/shared/http/validar-con.ts`). `$queryRawUnsafe` prohibido. `faker` no se usa (la 6.6.6 está comprometida).
- **Sin acceso al evento ⇒ 404, nunca 403**; 403 sólo para quien tiene acceso pero no permiso para esa operación.
- **Los tokens (RSVP, refresh, access) nunca se registran** en logs, errores ni metadata de auditoría.
- **Transacciones**: toda escritura que pueda correr dentro de `UnidadDeTrabajo` usa `clienteDe(this.prisma)`.
- **Dobles en memoria** (`*.fake.ts`): nunca más permisivos que Prisma; todo cambio de repositorio va a los dos.
- **jobIds de BullMQ** con `-`, nunca `:`.
- **Prettier**: sin punto y coma, comillas simples, ancho 100. Los `.md` no se reformatean.
- **Commits en español**, imperativo, prefijo convencional. **DESIGN-GAP** en comentario para toda desviación deliberada.
- **Servicios**: nunca arrancar, parar ni USAR servicios del host (el Postgres/Redis de Homebrew del usuario). Sólo Testcontainers.
- **Baseline** al empezar: 483/483 tests, smoke 5/5, typecheck limpio, depcruise sin violaciones, ESLint 0 errores / 25 avisos.

---

### Task 1: Arnés de tests estable

**Files:**
- Modify: `test/support/app.ts`
- Create: `test/support/throttler.ts`
- Modify: `test/e2e/health.e2e.test.ts`, `test/e2e/auth.e2e.test.ts`, `test/e2e/guests.e2e.test.ts` y todo `test/e2e/*.e2e.test.ts` que use `request(server)`
- Test: los mismos e2e

**Interfaces:**
- Produces: `arrancarAppDeTest(): Promise<{ app: NestExpressApplication; url: string; cerrar(): Promise<void> }>` y `limpiarContadoresDeRitmo(redisUrl: string): Promise<void>`. Todas las tareas posteriores escriben sus e2e con esto.

- [ ] **Step 1: Diagnosticar el 403 antes de tocar nada**

En `test/e2e/health.e2e.test.ts`, en el bucle de 125 peticiones, sustituye temporalmente `.expect(200)` por una captura que, si el estado no es 200, imprime `status`, cabeceras y cuerpo:

```ts
const r = await request(server).get(ruta)
if (r.status !== 200) {
  console.error('DIAGNOSTICO', r.status, JSON.stringify(r.headers), JSON.stringify(r.body))
  throw new Error(`estado inesperado ${r.status}`)
}
```

Ejecuta la suite completa hasta 5 veces seguidas (`npm test`) o hasta que el fallo aparezca. Anota en el informe si la respuesta 403 trae `x-request-id` y el cuerpo `{ code, message }` del `DomainExceptionFilter`. Sin `x-request-id` ⇒ la respuesta no es de nuestra app (hipótesis del puerto efímero confirmada). Si SÍ es de nuestra app, PARA y repórtalo como BLOCKED con el volcado: sería un defecto de producción y cambia la tarea.

- [ ] **Step 2: Helper que levanta el servidor una vez con `listen(0)`**

Añade a `test/support/app.ts`:

```ts
/**
 * La app como `main.ts`, ESCUCHANDO en un puerto real elegido por el sistema.
 * `request(app.getHttpServer())` sobre un servidor que no escucha hace que
 * supertest abra un puerto efímero por PETICIÓN; bajo la suite completa, con
 * workers en paralelo y el reenvío de puertos de Docker, alguna petición acaba
 * en otro proceso (403 ajenos, `socket hang up`). Un servidor por fichero,
 * escuchando una sola vez, elimina esa clase de fallo.
 */
export async function arrancarAppDeTest(): Promise<{
  app: NestExpressApplication
  url: string
  cerrar: () => Promise<void>
}> {
  const app = await crearAppComoMain()
  await app.listen(0, '127.0.0.1')
  const url = await app.getUrl()
  return { app, url: url.replace('[::1]', '127.0.0.1'), cerrar: () => app.close() }
}
```

- [ ] **Step 3: Limpieza de contadores del throttler**

Crea `test/support/throttler.ts`:

```ts
import { Redis } from 'ioredis'

/**
 * Borra los contadores de ritmo de `@nest-lab/throttler-storage-redis` para que
 * un test no herede un límite agotado por otro. Sólo toca las claves del
 * throttler, nunca las de BullMQ.
 */
export async function limpiarContadoresDeRitmo(redisUrl: string): Promise<void> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 })
  try {
    let cursor = '0'
    do {
      const [siguiente, claves] = await redis.scan(cursor, 'MATCH', '*throttler*', 'COUNT', 500)
      if (claves.length > 0) await redis.del(...claves)
      cursor = siguiente
    } while (cursor !== '0')
  } finally {
    redis.disconnect()
  }
}
```

Antes de usarlo, comprueba en Redis (en un test, con `KEYS *` sobre el contenedor) el prefijo real de las claves del almacén y ajusta el patrón `MATCH` si no contiene `throttler`. Cita el prefijo real en el informe.

- [ ] **Step 4: Migrar todos los e2e al servidor que escucha**

En cada `test/e2e/*.e2e.test.ts`: `beforeAll` usa `arrancarAppDeTest()`, guarda `url`, y todas las peticiones pasan de `request(server)` a `request(url)`. `afterAll` llama a `cerrar()`. Los ficheros que prueban límites de ritmo (`auth`, `rsvp`, `health`, `resend-webhook`) llaman a `limpiarContadoresDeRitmo(redisUrl)` en `beforeEach`. Elimina el código de diagnóstico del Step 1.

- [ ] **Step 5: Verificar**

Run: `npm test` cinco veces seguidas.
Expected: 5/5 ejecuciones con todos los tests en verde. Cita el recuento de cada una.

- [ ] **Step 6: Commit**

```bash
git add test/
git commit -m "test: servidor de e2e escuchando en un puerto y contadores de ritmo limpios"
```

---

### Task 2: e2e sin dependencia del orden

**Files:**
- Modify: `test/e2e/event-access.e2e.test.ts`, `test/e2e/event-vendors.e2e.test.ts`, `test/e2e/guests.e2e.test.ts`, `test/e2e/auth.e2e.test.ts`

**Interfaces:**
- Consumes: `arrancarAppDeTest`, `limpiarContadoresDeRitmo` (Task 1).

- [ ] **Step 1: Hacer visible el acoplamiento**

Ejecuta cada `it` de esos cuatro ficheros aislado, por ejemplo:

```bash
npx vitest run test/e2e/event-vendors.e2e.test.ts -t "actualiza el status"
```

Anota en el informe qué tests fallan aislados. Esa lista es el alcance de la tarea.

- [ ] **Step 2: Cada test crea sus datos**

Para cada test de la lista, mueve su preparación (usuarios, evento, membresías, invitados, contrataciones) a helpers locales del fichero (`async function prepararBodaCon(...)`) que se llaman dentro del propio test o en un `beforeEach`, con nombres/correos únicos por test (`randomUUID()` en el correo). Reglas concretas:
- `event-vendors`: `'actualiza el status'` deja de usar `listado.body[0]` y usa el id que su propio test crea. La aserción `length >= 2` del listado pasa a `toHaveLength(n)` exacto y `every(v => v.eventId === evento)`.
- `event-access`: el test de REVOKED deja de depender de que otro test haya activado la membresía de Pedro; activa la suya.
- `guests`: `'el mismo correo SÍ puede estar invitado a otra boda'` crea su propio primer invitado; `'pagina con cursor'` pagina sobre un evento propio con un número exacto de invitados.
- `auth`: el test de spraying no depende de su posición (la limpieza de contadores de la Task 1 lo permite).

- [ ] **Step 3: Verificar aislamiento y conjunto**

Run: cada test de la lista del Step 1, aislado con `-t`. Expected: PASS todos.
Run: `npx vitest run test/e2e/ --sequence.shuffle`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/
git commit -m "test: cada e2e prepara sus propios datos y no depende del orden"
```

---

### Task 3: Configuración — engine-strict, limitador del webhook y CI

**Files:**
- Create: `.npmrc`
- Modify: `src/shared/http/limitadores.ts`, `src/modules/guests/interfaces/resend-webhook.controller.ts`, `.github/workflows/ci.yml`, `package.json`
- Test: `test/e2e/resend-webhook.e2e.test.ts`

**Interfaces:**
- Produces: `LIMITADOR_WEBHOOK = 'webhook'` en `limitadores.ts`, aplicable con `@LimiteDeRuta`.

- [ ] **Step 1: Test que falla**

En `test/e2e/resend-webhook.e2e.test.ts`:

```ts
it('el webhook no lleva el límite global sino el suyo propio', async () => {
  const respuesta = await request(url)
    .post('/webhooks/resend')
    .set('Content-Type', 'application/json')
    .send('{}')

  expect(respuesta.headers['x-ratelimit-limit-global']).toBeUndefined()
  expect(respuesta.headers['x-ratelimit-limit-webhook']).toBe('1200')
})
```

Run: `npx vitest run test/e2e/resend-webhook.e2e.test.ts -t "límite global"` → FAIL (hoy trae `-global` y no `-webhook`).

- [ ] **Step 2: Limitador propio**

En `limitadores.ts`: añade `export const LIMITADOR_WEBHOOK = 'webhook'`, amplía `LimitadorDeRuta` con él, y en `crearLimitadores` añade:

```ts
{
  name: LIMITADOR_WEBHOOK,
  ttl: 60_000,
  limit: 1200,
  skipIf: (contexto) => !pedidoEn(contexto, LIMITADOR_WEBHOOK),
},
```

El `global` gana un `skipIf` que lo salta SÓLO donde se pide `webhook`:

```ts
{
  name: LIMITADOR_GLOBAL,
  ttl: 60_000,
  limit: limiteGlobalPorMinuto,
  // El webhook de Resend llega en ráfagas desde pocas IPs de Svix; su barrera
  // es la firma. Lleva su propio límite, más alto.
  skipIf: (contexto) => pedidoEn(contexto, LIMITADOR_WEBHOOK),
},
```

Actualiza el docblock del fichero con la tercera clase de limitador.

- [ ] **Step 3: Aplicarlo al controlador**

En `resend-webhook.controller.ts`, sobre el método `recibir`:

```ts
@LimiteDeRuta(LIMITADOR_WEBHOOK, { limit: 1200, ttl: 60_000 })
```

- [ ] **Step 4: Verificar**

Run: `npx vitest run test/e2e/resend-webhook.e2e.test.ts` → PASS.
Mutación: quita el `skipIf` del `global` → el test nuevo falla por `-global` presente. Restaura.

- [ ] **Step 5: engine-strict y CI**

Crea `.npmrc` con una línea: `engine-strict=true`. En `package.json`, `test:smoke` deja de compilar: `"test:smoke": "vitest run --config vitest.smoke.config.ts"`, y en `ci.yml` el paso "Humo del build compilado" sigue al paso "Build" (ya lo hace). Añade al README, en la sección de scripts, que `test:smoke` exige un `npm run build` previo.

Run: `npm ci` → exit 0 con el Node de `.nvmrc`. Run: `npm run build && npm run test:smoke` → 5/5.

- [ ] **Step 6: Commit**

```bash
git add .npmrc package.json .github/workflows/ci.yml README.md src/shared/http/limitadores.ts src/modules/guests/interfaces/resend-webhook.controller.ts test/e2e/resend-webhook.e2e.test.ts
git commit -m "feat: webhook con límite propio, engine-strict y CI sin doble build"
```

---

### Task 4: RSVP modificable con plazo de cierre

**Files:**
- Modify: `prisma/schema.prisma` + nueva migración `prisma/migrations/<timestamp>_rsvp_deadline/migration.sql`
- Modify: `src/modules/guests/domain/invitation.ts`, `src/modules/guests/domain/guest-errors.ts`
- Modify: `src/modules/guests/application/invitation.repository.ts`, `invitacion-valida.ts`, `get-rsvp.use-case.ts`, `submit-rsvp.use-case.ts`
- Modify: `src/modules/guests/infrastructure/prisma-invitation.repository.ts`, `invitation.repository.fake.ts`
- Modify: `src/modules/events/interfaces/events.dto.ts`, `src/modules/events/application/create-event.use-case.ts`, `src/modules/events/application/event.repository.ts`, `src/modules/events/infrastructure/prisma-event.repository.ts`, `event.repository.fake.ts`, `src/modules/events/domain/event.ts`
- Test: `src/modules/guests/domain/invitation.test.ts`, `src/modules/guests/application/submit-rsvp.use-case.test.ts`, `get-rsvp.use-case.test.ts`, `src/modules/guests/infrastructure/prisma-invitation.repository.test.ts`, `test/e2e/rsvp.e2e.test.ts`

**Interfaces:**
- Produces:
  - `DIAS_DE_CIERRE_POR_DEFECTO = 14` en `src/modules/events/domain/event.ts`; `Event` gana `rsvpDeadlineDays: number`.
  - En `guests/domain/invitation.ts`: `cierreRsvp(evento: { weddingDate: Date; rsvpDeadlineDays: number }): Date`, `admiteLectura(inv: { expiresAt: Date }, ahora: Date): boolean`, `admiteRespuesta(inv: { expiresAt: Date }, evento: { weddingDate: Date; rsvpDeadlineDays: number }, ahora: Date): boolean`.
  - `InvitacionCompleta.event` gana `rsvpDeadlineDays: number`.
  - `class RsvpCerradoError extends UnprocessableError` con code `RSVP_CLOSED`.
  - `VistaPublicaRsvp` gana `rsvpClosesAt: string`.
  - `jobIdDeAvisoRsvp(invitationId: string, respondidaEn: Date): string` → `rsvp-<invitationId>-<epochMs>`.

- [ ] **Step 1: Tests de dominio que fallan**

En `src/modules/guests/domain/invitation.test.ts` añade:

```ts
describe('plazo del RSVP', () => {
  const evento = { weddingDate: new Date('2027-06-20T00:00:00Z'), rsvpDeadlineDays: 14 }

  it('cierra rsvpDeadlineDays días antes de la boda', () => {
    expect(cierreRsvp(evento).toISOString()).toBe('2027-06-06T00:00:00.000Z')
  })

  it('con 0 días cierra el mismo día de la boda', () => {
    expect(cierreRsvp({ ...evento, rsvpDeadlineDays: 0 }).toISOString()).toBe(
      '2027-06-20T00:00:00.000Z',
    )
  })

  it('admite respuesta antes del cierre, también si ya respondió', () => {
    const inv = { expiresAt: new Date('2027-09-01T00:00:00Z') }
    expect(admiteRespuesta(inv, evento, new Date('2027-06-05T23:59:59Z'))).toBe(true)
  })

  it('no admite respuesta desde el cierre', () => {
    const inv = { expiresAt: new Date('2027-09-01T00:00:00Z') }
    expect(admiteRespuesta(inv, evento, new Date('2027-06-06T00:00:00Z'))).toBe(false)
  })

  it('no admite respuesta ni lectura con el token caducado', () => {
    const inv = { expiresAt: new Date('2027-01-01T00:00:00Z') }
    const ahora = new Date('2027-01-02T00:00:00Z')
    expect(admiteRespuesta(inv, evento, ahora)).toBe(false)
    expect(admiteLectura(inv, ahora)).toBe(false)
  })

  it('admite lectura tras el cierre mientras el token no caduque', () => {
    const inv = { expiresAt: new Date('2027-09-01T00:00:00Z') }
    expect(admiteLectura(inv, new Date('2027-06-10T00:00:00Z'))).toBe(true)
  })
})
```

Borra los tests existentes de `admiteRespuesta` que afirman "un token RESPONDED no admite respuesta": esa regla deja de existir. Run: `npx vitest run src/modules/guests/domain/invitation.test.ts` → FAIL (`cierreRsvp`/`admiteLectura` no existen).

- [ ] **Step 2: Implementar el dominio**

En `invitation.ts`, sustituye `admiteRespuesta` por:

```ts
/** Momento a partir del cual el invitado ya no puede cambiar su respuesta. */
export function cierreRsvp(evento: { weddingDate: Date; rsvpDeadlineDays: number }): Date {
  return new Date(evento.weddingDate.getTime() - evento.rsvpDeadlineDays * 86_400_000)
}

/**
 * ¿Sirve el token para VER la invitación? Sólo mira la caducidad: se puede leer
 * en cualquier estado, también ya respondida y también pasado el cierre, para
 * que el invitado vea lo que contestó. `expiresAt` incluye la caducidad forzada
 * del ruling C18.
 */
export function admiteLectura(invitacion: { expiresAt: Date }, ahora: Date): boolean {
  return invitacion.expiresAt.getTime() > ahora.getTime()
}

/**
 * ¿Sirve el token para RESPONDER (o cambiar la respuesta)? Token vivo y antes
 * del cierre. Ya no es de un solo uso (decisión del usuario, bloque A §2): una
 * invitación RESPONDED se puede responder otra vez hasta el cierre.
 */
export function admiteRespuesta(
  invitacion: { expiresAt: Date },
  evento: { weddingDate: Date; rsvpDeadlineDays: number },
  ahora: Date,
): boolean {
  return admiteLectura(invitacion, ahora) && ahora.getTime() < cierreRsvp(evento).getTime()
}
```

En `guest-errors.ts`:

```ts
/** Token válido pero fuera de plazo: verlo exige tener el token, así que no filtra nada. */
export class RsvpCerradoError extends UnprocessableError {
  constructor() {
    super('El plazo para cambiar la respuesta ha terminado', 'RSVP_CLOSED')
  }
}
```

Run: `npx vitest run src/modules/guests/domain/invitation.test.ts` → PASS.

- [ ] **Step 3: Migración y `Event.rsvpDeadlineDays`**

En `prisma/schema.prisma`, `model Event`, tras `venueLocation`:

```prisma
  rsvpDeadlineDays Int      @default(14)
```

Genera la migración: `npx prisma migrate dev --name rsvp_deadline --create-only` contra el Postgres de Testcontainers (arranca uno con `test/support/containers.ts` desde un script temporal en el scratchpad, NUNCA contra el Postgres del host). Añade al SQL un CHECK:

```sql
ALTER TABLE "events" ADD CONSTRAINT "events_rsvp_deadline_days_rango"
  CHECK ("rsvpDeadlineDays" BETWEEN 0 AND 365);
```

Propaga el campo: `Event` de dominio (`rsvpDeadlineDays: number`), `DIAS_DE_CIERRE_POR_DEFECTO = 14` en `events/domain/event.ts`, `crearConMembresia` acepta `rsvpDeadlineDays?: number`, Prisma y doble lo guardan (el doble aplica el default 14). `createEventSchema` gana `rsvpDeadlineDays: z.number().int().min(0).max(365).optional()`, y `CreateEventUseCase` lo pasa. `InvitacionCompleta.event` gana `rsvpDeadlineDays`, y `aInvitacion` lo copia de `fila.guest.event.rsvpDeadlineDays`; el doble de invitaciones también.

- [ ] **Step 4: Tests de casos de uso que fallan**

En `submit-rsvp.use-case.test.ts` (con los dobles existentes):

```ts
it('permite cambiar la respuesta ya dada antes del cierre', async () => {
  const { token } = await prepararInvitacionValida()
  await caso.ejecutar(token, { rsvp: 'CONFIRMED' })

  await caso.ejecutar(token, { rsvp: 'DECLINED' })

  expect(invitados.porId(guestId)?.rsvp).toBe('DECLINED')
})

it('tras el cierre responde RSVP_CLOSED y no toca nada', async () => {
  const { token } = await prepararInvitacionValida({ weddingDate: diasDesdeHoy(10) })

  await expect(caso.ejecutar(token, { rsvp: 'CONFIRMED' })).rejects.toBeInstanceOf(
    RsvpCerradoError,
  )
  expect(invitados.porId(guestId)?.rsvp).toBe('PENDING')
  expect(cola.encolados).toHaveLength(0)
})

it('cada respuesta encola su propio aviso', async () => {
  const { token } = await prepararInvitacionValida()
  await caso.ejecutar(token, { rsvp: 'CONFIRMED' })
  await caso.ejecutar(token, { rsvp: 'DECLINED' })

  const ids = cola.encolados.map((j) => j.opciones?.jobId)
  expect(new Set(ids).size).toBe(2)
  expect(ids.every((id) => id !== undefined && !id.includes(':'))).toBe(true)
})
```

Adapta `prepararInvitacionValida` para aceptar `weddingDate` y usa `rsvpDeadlineDays: 14` por defecto (con `diasDesdeHoy(10)` la boda está a 10 días, ya pasado el cierre de 14). Usa los nombres reales de los dobles del fichero (`porId`, `encolados`, `opciones`); si difieren, adapta y cítalos en el informe.

En `get-rsvp.use-case.test.ts`:

```ts
it('con el token ya usado devuelve la respuesta actual y el cierre', async () => {
  const { token } = await prepararInvitacionValida()
  await responder(token, { rsvp: 'CONFIRMED', dietary: 'Vegan' })

  const vista = await caso.ejecutar(token)

  expect(vista.rsvp).toBe('CONFIRMED')
  expect(vista.dietary).toBe('Vegan')
  expect(vista.rsvpClosesAt).toBe(cierreRsvp(evento).toISOString())
})
```

Run: ambos ficheros → FAIL.

- [ ] **Step 5: Implementar los casos de uso**

`invitacion-valida.ts` pasa a exportar dos funciones:

```ts
/** GET: token vivo en cualquier estado. */
export async function buscarInvitacionLegible(
  invitaciones: InvitationRepository,
  token: string,
  ahora: Date,
): Promise<InvitacionCompleta> {
  const invitacion = await invitaciones.buscarPorHash(hashDeToken(token))
  if (invitacion === null || !admiteLectura(invitacion, ahora)) {
    throw new InvitacionNoValidaError()
  }
  return invitacion
}

/**
 * POST: además, antes del cierre. Un token inexistente o caducado da el mismo
 * 404 que siempre; uno vivo fuera de plazo, `RsvpCerradoError` (422).
 */
export async function buscarInvitacionRespondible(
  invitaciones: InvitationRepository,
  token: string,
  ahora: Date,
): Promise<InvitacionCompleta> {
  const invitacion = await buscarInvitacionLegible(invitaciones, token, ahora)
  if (!admiteRespuesta(invitacion, invitacion.event, ahora)) throw new RsvpCerradoError()
  return invitacion
}
```

`GetRsvpUseCase` usa `buscarInvitacionLegible` y añade `rsvpClosesAt: cierreRsvp(invitacion.event).toISOString()` a la vista; sustituye el DESIGN-GAP del docblock por uno nuevo que cite la decisión del usuario (bloque A §2).

`SubmitRsvpUseCase` usa `buscarInvitacionRespondible`, y:

```ts
export function jobIdDeAvisoRsvp(invitationId: string, respondidaEn: Date): string {
  return `rsvp-${invitationId}-${respondidaEn.getTime()}`
}
```

con `jobId: jobIdDeAvisoRsvp(invitacion.id, ahora)`. Corrige los docblocks que hablan de "un solo uso".

- [ ] **Step 6: La escritura condicionada**

`InvitationRepository.marcarRespondida(id, ahora)` cambia de contrato: escribe si `expiresAt > ahora`, en CUALQUIER estado. Prisma:

```ts
const { count } = await clienteDe(this.prisma).guestInvitation.updateMany({
  where: { id, expiresAt: { gt: ahora } },
  data: { status: 'RESPONDED', respondedAt: ahora },
})
return count === 1
```

El doble aplica la misma regla. Actualiza el docblock del puerto: el cierre se comprueba en la lectura porque sus datos no los escribe el flujo del RSVP.

`caducarVigentesDe` deja de excluir RESPONDED (Prisma y doble):

```ts
where: { guestId, expiresAt: { gt: ahora } },
```

Reescribe su docblock: con el RSVP modificable, un token RESPONDED sigue pudiendo cambiar la respuesta, así que también hay que matarlo.

- [ ] **Step 7: Tests de integración y e2e**

En `prisma-invitation.repository.test.ts` (suite paramétrica Prisma/doble si existe; si no, sobre los dos):
- `marcarRespondida` sobre una fila RESPONDED devuelve `true` y actualiza `respondedAt`.
- `caducarVigentesDe` caduca también una fila RESPONDED vigente.

En `test/e2e/rsvp.e2e.test.ts`:
- `GET /rsvp/<token>` tras responder → 200 con `rsvp` y `rsvpClosesAt`.
- `POST` dos veces (CONFIRMED y luego DECLINED) → 204 las dos; el invitado queda DECLINED; hay DOS jobs `guest.rsvp.updated` en la cola `notifications` (búscalos por `getJobs`).
- Evento con boda a 3 días → `POST` da 422 con `code: 'RSVP_CLOSED'`; `GET` sigue dando 200.
- Reenviar la invitación a un invitado que YA respondió → el token viejo da 404 en `GET` y en `POST`.
- Sustituye los tests existentes que afirman "un token usado da 404".

Run: `npm test` → PASS.
Mutaciones (restaura cada una): (a) quitar la comprobación del cierre en `admiteRespuesta` → falla el test de RSVP_CLOSED; (b) volver al jobId sin marca de tiempo → falla "cada respuesta encola su propio aviso"; (c) volver a excluir RESPONDED en `caducarVigentesDe` → falla el e2e de reenvío.

- [ ] **Step 8: Commit**

```bash
git add prisma/ src/modules/guests src/modules/events test/e2e/rsvp.e2e.test.ts
git commit -m "feat: el invitado puede cambiar su RSVP hasta el cierre del evento"
```

---

### Task 5: Auth — carrera del refresh, JWT y código del 401

**Files:**
- Modify: `src/modules/auth/infrastructure/prisma-session.repository.ts`, `session.repository.fake.ts`, `src/modules/auth/application/session.repository.ts`
- Modify: `src/modules/auth/application/token.service.ts`, `src/modules/auth/interfaces/jwt-auth.guard.ts`
- Modify: `src/config/env.schema.ts` (sólo `JWT_ACCESS_TTL`), `package.json` (quitar `@nestjs/jwt`)
- Test: `src/modules/auth/infrastructure/prisma-session.repository.test.ts` (nuevo), `src/modules/auth/application/token.service.test.ts` (nuevo), `src/modules/auth/interfaces/jwt-auth.guard.test.ts`, `src/config/env.test.ts`, `test/e2e/auth.e2e.test.ts`

**Interfaces:**
- Produces: `SessionRepository` SIN `revocar` (sólo `crear`, `buscarPorHash`, `rotar`, `revocarFamilia`).

- [ ] **Step 1: Test de integración de la carrera (Postgres real)**

Crea `prisma-session.repository.test.ts` con `startPostgres()`:

```ts
it('revocar la familia no deja viva a la hija de una rotación concurrente', async () => {
  const familyId = randomUUID()
  const padre = await crearSesion({ familyId })
  const hermana = await crearSesion({ familyId })

  // La rotación de la hermana y la revocación de la familia, a la vez.
  await Promise.all([
    repo.rotar({ sesionARevocar: hermana.id, nueva: datosNueva(familyId) }),
    repo.revocarFamilia(familyId),
  ])

  const vivas = await prisma.session.count({ where: { familyId, revokedAt: null } })
  expect(vivas).toBe(0)
})
```

Repite el test 50 veces en un bucle dentro del mismo `it` (cada vuelta con una familia nueva): la carrera es probabilística. Run → anota si falla. Si pasa las 50 vueltas antes del arreglo, dilo en el informe (la ventana es estrecha) y conserva el test igualmente.

- [ ] **Step 2: Serializar por familia**

En `PrismaSessionRepository`, `rotar` y `revocarFamilia` toman el mismo cerrojo transaccional al principio:

```ts
private async bloquearFamilia(tx: Prisma.TransactionClient, familyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${familyId}))`
}
```

`rotar` lee primero el `familyId` de la sesión a revocar (`findUnique`), bloquea, y sigue como hoy. `revocarFamilia` pasa a `this.prisma.$transaction(async (tx) => { await this.bloquearFamilia(tx, familyId); await tx.session.updateMany(...) })`. Explica en el docblock por qué: sin el cerrojo, el `UPDATE` de la familia usa una instantánea que no ve a la hija que inserta una rotación concurrente.

Quita `revocar` del puerto, del adaptador y del doble. Run: el test del Step 1 → PASS; `npx vitest run src/modules/auth` → PASS.

- [ ] **Step 3: JWT — algoritmo fijo y TTL validado**

Test en `token.service.test.ts`:

```ts
it('rechaza un token firmado con otro algoritmo', () => {
  const ajeno = jwt.sign({ sub: 'u', role: 'USER' }, secreto, { algorithm: 'HS512' })
  expect(() => servicio.verificarAccess(ajeno)).toThrow()
})

it('firma y verifica un token de acceso', () => {
  const token = servicio.firmarAccess({ id: 'u-1', systemRole: 'USER' })
  expect(servicio.verificarAccess(token)).toEqual({ sub: 'u-1', role: 'USER' })
})

it('el refresh es opaco y su hash no es el token', () => {
  const { token, hash } = servicio.generarRefresh()
  expect(hash).toBe(hashToken(token))
  expect(hash).not.toContain(token)
})
```

`verificarAccess` pasa `{ algorithms: ['HS256'] }` a `jwt.verify`; `firmarAccess` pasa `algorithm: 'HS256'` y quita el `as jwt.SignOptions`.

En `env.schema.ts`:

```ts
/** Duración de `jsonwebtoken`/`ms`: un número seguido de s, m, h o d. Vacío = por defecto. */
JWT_ACCESS_TTL: z.preprocess(
  (valor) => (valor === '' ? undefined : valor),
  z.string().regex(/^\d+[smhd]$/, 'Duración como 15m, 1h o 30s').default('15m'),
),
```

Tests en `env.test.ts`: `'15minutes'` rechazado al arrancar; `''` toma `15m`.

- [ ] **Step 4: Código estable del 401 del guard**

Test en `jwt-auth.guard.test.ts` y e2e en `auth.e2e.test.ts`:

```ts
it('sin token responde 401 con code UNAUTHORIZED', async () => {
  const { body } = await request(url).get('/auth/me').expect(401)
  expect(body.code).toBe('UNAUTHORIZED')
})
```

En `jwt-auth.guard.ts`, en lugar de `UnauthorizedException` de Nest, lanza `UnauthorizedError` del dominio (`@/shared/domain`) con el mismo mensaje `ACCESS_TOKEN_RECHAZADO`, en los tres sitios (cabecera ausente, cabecera mal formada y la rama del `catch` que ya discrimina `UnauthorizedError`). Mantén el relanzamiento de lo que no sea `UnauthorizedError` (500 ante una caída de la base).

- [ ] **Step 5: Quitar `@nestjs/jwt`**

`npm uninstall @nestjs/jwt`. Comprueba con `grep -rn "@nestjs/jwt" src test` que no queda ningún import.

- [ ] **Step 6: Verificar y commit**

Run: `npm test`, `npm run typecheck`, `npm run lint` → verdes.

```bash
git add -A src/modules/auth src/config package.json package-lock.json test/e2e/auth.e2e.test.ts
git commit -m "fix: refresh serializado por familia, JWT HS256 y 401 con código estable"
```

---

### Task 6: Entorno y Swagger

**Files:**
- Modify: `src/config/env.schema.ts`, `src/config/env.ts`, `src/configurar-app.ts`, `.env.example`, `README.md`
- Test: `src/config/env.test.ts`, `test/e2e/security-headers.e2e.test.ts`

- [ ] **Step 1: Tests que fallan**

En `env.test.ts`:

```ts
it('APP_URL sólo acepta http o https', () => {
  expect(() => loadEnv({ ...valido, APP_URL: 'ftp://app.example.com' })).toThrow(/APP_URL/)
})

it('en producción, example.com cuenta como remitente de prueba', () => {
  expect(() =>
    loadEnv({ ...validoProduccion, MAIL_FROM: 'no-reply@example.com' }),
  ).toThrow(/MAIL_FROM/)
})

it('un error de una variable no oculta los de producción', () => {
  expect(() =>
    loadEnv({ ...validoProduccion, PORT: 'abc', MAIL_DRIVER: 'fake' }),
  ).toThrow(/PORT[\s\S]*MAIL_DRIVER|MAIL_DRIVER[\s\S]*PORT/)
})

it('DOCS_ENABLED es false por defecto en producción y true fuera', () => {
  expect(loadEnv(validoProduccion).DOCS_ENABLED).toBe(false)
  expect(loadEnv(valido).DOCS_ENABLED).toBe(true)
})
```

Usa los objetos de entorno válidos que ya tenga el fichero (`valido`, `validoProduccion`); si se llaman distinto, adapta. Run → FAIL.

- [ ] **Step 2: Implementar**

- `APP_URL: z.url({ protocol: /^https?$/ })`.
- `TLD_RESERVADO` pasa a cubrir los nombres de segundo nivel de RFC 2606: `/(\.(test|example|invalid|localhost)|(^|[.@])example\.(com|net|org))$/i`, y se aplica al dominio del correo.
- `DOCS_ENABLED: opcional(z.enum(['true', 'false']).transform((v) => v === 'true'))`, y tras el `superRefine`, un `.transform` que resuelve el defecto: `DOCS_ENABLED ?? env.NODE_ENV !== 'production'`.
- Para que un error no oculte otros: el `superRefine` sólo corre si el objeto base parsea. Sepáralo: valida primero el objeto base con `safeParse`; valida las reglas cruzadas sobre los campos que SÍ parsearon (`NODE_ENV`, `MAIL_DRIVER`, `MAIL_FROM`, `JWT_ACCESS_SECRET`, `RESEND_WEBHOOK_SECRET`) leyendo el entorno crudo con esquemas sueltos; y `loadEnv` (`src/config/env.ts`) junta las dos listas de issues en el mismo error. Documenta el porqué en el docblock.
- En `configurar-app.ts`, `SwaggerModule.setup` sólo si `env.DOCS_ENABLED`.
- `.env.example` gana `DOCS_ENABLED=` y el README explica las tres nuevas reglas y que `TRUST_PROXY` es OBLIGATORIO detrás de un balanceador (sin él, todos los invitados comparten un contador).

- [ ] **Step 3: Verificar**

e2e en `security-headers.e2e.test.ts`: con `fijarEntorno(..., { DOCS_ENABLED: 'false' })`, `GET /docs` y `GET /openapi.json` → 404.
Run: `npx vitest run src/config test/e2e/security-headers.e2e.test.ts` → PASS. Run: `npm run build && npm run test:smoke` → 5/5 (el smoke arranca en producción: si ahora falla por `DOCS_ENABLED`, no debería; si falla por otra regla, arréglalo en el smoke, no relajando la regla).

- [ ] **Step 4: Commit**

```bash
git add src/config src/configurar-app.ts .env.example README.md test/e2e/security-headers.e2e.test.ts
git commit -m "fix: entorno más estricto y Swagger apagado en producción"
```

---

### Task 7: Ids mal formados, P2025 y el email del invitado

**Files:**
- Create: `src/shared/http/id-de-ruta.ts`
- Modify: `src/modules/guests/interfaces/guests.controller.ts`, `src/modules/vendors/interfaces/event-vendors.controller.ts`, `src/shared/domain/cursor.ts`
- Modify: `src/modules/guests/infrastructure/prisma-guest.repository.ts`, `src/modules/vendors/infrastructure/prisma-event-vendor.repository.ts`
- Modify: `src/modules/guests/interfaces/guest.dto.ts`
- Test: `src/shared/domain/cursor.test.ts`, `test/e2e/guests.e2e.test.ts`, `test/e2e/event-vendors.e2e.test.ts`

**Interfaces:**
- Produces: `idDeRuta(valor: string, error: () => DomainError): string` en `src/shared/http/id-de-ruta.ts`.

- [ ] **Step 1: Tests que fallan**

e2e:
- `GET /events/<evento>/guests/no-es-uuid` → 404 `GUEST_NOT_FOUND` (el code real del error de invitado; cítalo).
- `PATCH /events/<evento>/vendors/no-es-uuid` → 404.
- `GET /events/<evento>/guests?cursor=<cursor con i:"x">` → 400 con el mismo cuerpo que un cursor inválido hoy.
- `PATCH /events/<evento>/guests/<id>` con `{ "email": null }` → 200 y el invitado queda sin email.
- `PATCH` con `{}` → 400 con `message` que contiene `Indica al menos un cambio`.

Unitario en `cursor.test.ts`: `decodeCursor(encodeCursor({ createdAt: new Date(), id: 'x' }))` lanza `InvalidCursorError`.

Run → FAIL.

- [ ] **Step 2: Implementar**

`src/shared/http/id-de-ruta.ts`:

```ts
import type { DomainError } from '@/shared/domain'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Un id de ruta que no es UUID no puede existir: se responde con el MISMO 404
 * que un id inexistente, en vez de dejar que Prisma lo rechace como P2023 (500).
 */
export function idDeRuta(valor: string, error: () => DomainError): string {
  if (!UUID.test(valor)) throw error()
  return valor
}
```

Úsalo en los handlers con `guestId` y `eventVendorId` (con `() => new InvitadoNoEncontradoError()` y el error equivalente de vendors). `EventAccessGuard` ya valida `eventId`; `notificationId` ya usa `z.guid()`.

`decodeCursor` valida `i` con la misma regex UUID antes de devolver.

P2025: en `actualizar` de `prisma-guest.repository.ts` y de `prisma-event-vendor.repository.ts`, cambia `findFirstOrThrow` por `findFirst` y, si devuelve `null`, lanza el error de dominio de "no encontrado" del módulo.

`guest.dto.ts`: `actualizarInvitadoSchema` sobrescribe `email: z.email().nullable().optional()`. Comprueba que `CambiosInvitado.email` ya admite `null` (el revisor dijo que el puerto lo soporta) y que `UpdateGuestUseCase` caduca los tokens también al pasar a `null` (ya lo hace; el test de la Task 4 lo cubre).

- [ ] **Step 3: Verificar y commit**

Run: los ficheros de test tocados → PASS.

```bash
git add src/shared src/modules/guests src/modules/vendors test/e2e
git commit -m "fix: ids mal formados y filas borradas a mitad responden 404, no 500"
```

---

### Task 8: Invitaciones robustas y paridad del doble

**Files:**
- Modify: `src/modules/guests/interfaces/invitation.processor.ts`, `src/modules/mail/infrastructure/resend-mail.adapter.ts`, `src/modules/guests/application/handle-delivery-event.use-case.ts`
- Modify: `src/modules/guests/infrastructure/invitation.repository.fake.ts`
- Test: `src/modules/guests/interfaces/invitation.processor.test.ts`, `src/modules/guests/infrastructure/prisma-invitation.repository.test.ts`, `src/modules/guests/application/handle-delivery-event.use-case.test.ts`

- [ ] **Step 1: Respaldo para jobs atascados**

Test en `invitation.processor.test.ts`:

```ts
it('un job que falla sin pasar por process (stalled) caduca la invitación al agotar intentos', async () => {
  const invitacion = await sembrarInvitacionEnCola()
  const job = jobFalso({ attemptsMade: 5, opts: { attempts: 5 }, datos: payloadDe(invitacion) })

  await procesador.alFallar(job, new Error('job stalled more than allowable limit'))

  expect(invitaciones.porId(invitacion.id)?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now())
})

it('un fallo con intentos pendientes no caduca nada', async () => {
  const invitacion = await sembrarInvitacionEnCola()
  const job = jobFalso({ attemptsMade: 2, opts: { attempts: 5 }, datos: payloadDe(invitacion) })

  await procesador.alFallar(job, new Error('x'))

  expect(invitaciones.porId(invitacion.id)?.expiresAt.getTime()).toBeGreaterThan(Date.now())
})
```

Implementa en el procesador:

```ts
/**
 * Respaldo del ruling C18: un job que falla por STALLED nunca entra en el
 * `catch` de `process`. Cuando BullMQ lo da por perdido (sin intentos), se
 * caduca la invitación igual. Es idempotente con la caducidad de `process`.
 */
@OnWorkerEvent('failed')
async alFallar(job: Job | undefined, error: Error): Promise<void> {
  if (job === undefined) return
  const quedan = (job.opts.attempts ?? 1) - job.attemptsMade
  if (quedan > 0 && error.name !== 'UnrecoverableError') return
  const leido = payloadInvitacionSchema.safeParse(job.data)
  if (!leido.success) return
  await this.caducarSinOcultar(leido.data, error)
}
```

Usa el nombre real del esquema Zod del payload que ya existe en el fichero.

- [ ] **Step 2: `UnrecoverableError` por nombre y descartes registrados**

`esUltimoIntento` reconoce `error instanceof UnrecoverableError || (error instanceof Error && error.name === 'UnrecoverableError')`.

Los tres `return` silenciosos de `enviar` (invitación inexistente, estado distinto de QUEUED, invitado sin email) registran un `this.registro.log(...)` con `invitationId` y `requestId` y el motivo, nunca el token. Test: espía `Logger.prototype.log` y comprueba que el motivo aparece y el token no.

- [ ] **Step 3: 409 de idempotencia de Resend = enviado**

Lee en `node_modules/resend` el tipo de error que devuelve una clave de idempotencia repetida (su `name`/`statusCode`). En `resend-mail.adapter.ts`, si el error es ese conflicto, no lances: devuelve `{ providerMessageId }` si el SDK lo trae; si no lo trae, lanza `UnrecoverableError('Resend: clave de idempotencia ya usada con otro contenido')` para que no se reintente 5 veces. Cita en el informe qué devuelve el SDK. Test con el cliente de Resend sustituido por un doble.

- [ ] **Step 4: messageId sin casar**

En `handle-delivery-event.use-case.ts`, cuando `actualizarEstadoPorMessageId` devuelve `[]`, `this.registro.debug('Evento de Resend sin invitación que avanzar messageId=' + messageId)`. Test con espía.

- [ ] **Step 5: Paridad del doble de invitaciones**

El doble es más permisivo que Prisma. Arreglos:
- `crear` con un `guestId` que el doble no conoce lanza `InvitadoNoEncontradoError` (Prisma da P2003 → ese error).
- La fila creada toma `guest`/`event` del invitado registrado, no de valores por defecto.

Test paramétrico en `prisma-invitation.repository.test.ts` que corre los mismos casos sobre Prisma y sobre el doble: `crear` con guestId inexistente, `caducar` (pone `expiresAt <= now` y no lanza con id inexistente), `caducarVigentesDe`, `marcarRespondida`.

Borra el test tautológico `expect(COLA_INVITACIONES).not.toBe('email')` de `invitation.processor.test.ts`.

- [ ] **Step 6: Verificar y commit**

Run: `npx vitest run src/modules/guests src/modules/mail` → PASS.

```bash
git add src/modules/guests src/modules/mail
git commit -m "fix: invitaciones caducadas también por stalled, descartes registrados y doble fiel"
```

---

### Task 9: Sockets — desconexión al caducar y límite de `join`

**Files:**
- Modify: `src/modules/auth/application/token.service.ts`, `src/modules/auth/application/autenticar-access-token.ts`
- Modify: `src/modules/notifications/interfaces/notifications.gateway.ts`
- Test: `src/modules/notifications/interfaces/notifications.gateway.test.ts`, `test/e2e/realtime.e2e.test.ts`

**Interfaces:**
- Produces: `TokenService.verificarAccess(token)` → `{ sub: string; role: string; exp: number }` (segundos epoch); `autenticarAccessToken` devuelve `{ usuario: UsuarioAutenticado; expiraEn: Date }`. `JwtAuthGuard` usa `.usuario`.

- [ ] **Step 1: Tests que fallan**

En `notifications.gateway.test.ts`:

```ts
it('desconecta el socket cuando caduca su token', async () => {
  vi.useFakeTimers()
  const socket = await conectarConToken(tokenQueCaducaEn(60))

  vi.advanceTimersByTime(61_000)

  expect(socket.desconectado).toBe(true)
  vi.useRealTimers()
})

it('limita los join por socket', async () => {
  const socket = await conectarConToken(tokenValido())
  const respuestas = []
  for (let i = 0; i < 25; i += 1) respuestas.push(await socket.join(eventoAjeno))

  expect(respuestas.at(-1)).toEqual({ ok: false, error: 'RATE_LIMITED' })
})
```

Adapta `conectarConToken`/`socket.join` a los helpers reales del fichero. Run → FAIL.

- [ ] **Step 2: Implementar**

`verificarAccess` devuelve también `exp` (el claim numérico de `jsonwebtoken`; si falta, lanza). `autenticarAccessToken` devuelve `{ usuario, expiraEn: new Date(exp * 1000) }`; actualiza `JwtAuthGuard` y el gateway a la nueva forma.

En el middleware del gateway, tras autenticar:

```ts
const restante = expiraEn.getTime() - Date.now()
const temporizador = setTimeout(() => socket.disconnect(true), Math.max(restante, 0))
socket.once('disconnect', () => clearTimeout(temporizador))
```

Límite de `join`: cubo de fichas por socket en `socket.data` (20 `join` por minuto; se recarga a 20/60 fichas por segundo). Sin fichas, el ack es `{ ok: false, error: 'RATE_LIMITED' }` y NO se consulta la base de datos. Constante `JOINS_POR_MINUTO = 20` con su docblock.

- [ ] **Step 3: Verificar y commit**

Run: `npx vitest run src/modules/notifications src/modules/auth test/e2e/realtime.e2e.test.ts` → PASS.
Mutación: quitar el `setTimeout` → falla el test de caducidad. Restaura.

```bash
git add src/modules/auth src/modules/notifications test/e2e/realtime.e2e.test.ts
git commit -m "fix: sockets desconectados al caducar el token y joins limitados"
```

---

### Task 10: Logs de proxy y auditoría de proveedores sin datos personales

**Files:**
- Modify: `src/shared/logging/redaccion.ts`, `src/shared/logging/logger.ts`
- Modify: `src/modules/vendors/infrastructure/prisma-event-vendor.repository.ts`, `event-vendor.repository.fake.ts`, `src/modules/vendors/application/event-vendor.repository.ts`, `update-event-vendor.use-case.ts`, `remove-event-vendor.use-case.ts`
- Test: `test/e2e/logging.e2e.test.ts`, `test/e2e/event-vendors.e2e.test.ts`

- [ ] **Step 1: Cabeceras de proxy**

Test en `logging.e2e.test.ts`: una petición con `X-Original-URI: /rsvp/<token>`, `X-Forwarded-Uri: /rsvp/<token>` y `X-Rewrite-Url: /rsvp/<token>`; ninguna línea de log contiene el token y aparece el marcador de redacción. Implementa en el serializador de `logger.ts` pasando esas tres cabeceras por `urlParaRegistro`, igual que `referer`. Run → primero FAIL, luego PASS.

- [ ] **Step 2: Auditoría sin datos personales**

Test e2e: añadir un proveedor externo con nombre, email y teléfono, actualizarlo y borrarlo produce tres filas de `AuditLog` (`event_vendor.added`, `event_vendor.updated`, `event_vendor.removed`) y NINGUNA contiene el nombre, el email ni el teléfono en `metadata` (busca las tres cadenas en `JSON.stringify(fila.metadata)`).

Implementa:
- `metadata` de `added` pasa a `{ kind: vendorRef.kind, ...(kind === 'linked' ? { vendorProfileId } : {}) }`.
- `actualizar` y `eliminar` escriben su `AuditLog` en la MISMA transacción que la escritura (`this.prisma.$transaction`), con `metadata: { eventVendorId, campos: Object.keys(cambios) }` en `updated` y `{ eventVendorId }` en `removed`. El actor (`actorId`) llega por parámetro desde el caso de uso, igual que en `added`; amplía las firmas del puerto y del doble.

- [ ] **Step 3: Verificar y commit**

Run: `npx vitest run test/e2e/logging.e2e.test.ts test/e2e/event-vendors.e2e.test.ts src/modules/vendors` → PASS.

```bash
git add src/shared/logging src/modules/vendors test/e2e
git commit -m "fix: cabeceras de proxy redactadas y auditoría de proveedores sin datos personales"
```

---

### Task 11: Limpieza de gates y cobertura

**Files:**
- Modify: `.dependency-cruiser.cjs`, `test/architecture/dependency-rules.test.ts`, `eslint.config.mjs` (si hace falta), `src/modules/auth/interfaces/auth.controller.ts`, `src/modules/users/infrastructure/user.repository.fake.test.ts`, `src/shared/http/domain-exception.filter.e2e.test.ts`, `src/modules/guests/interfaces/invitation.processor.test.ts`
- Create: `src/modules/auth/application/register.use-case.test.ts`, `logout.use-case.test.ts`, `src/modules/notifications/infrastructure/notification.repository.paridad.test.ts`
- Modify: `src/modules/guests/application/list-guests.use-case.test.ts` (partir), `src/modules/guests/infrastructure/prisma-guest.repository.test.ts`, `test/smoke/arranque-compilado.smoke.test.ts`

- [ ] **Step 1: Regla de dependencias para tests**

En `.dependency-cruiser.cjs`, quita `exclude: { path: '\\.test\\.ts$' }` y añade una regla:

```js
{
  name: 'tests-solo-dobles-de-otros-modulos',
  comment: 'Un test puede usar la infrastructure/ de OTRO módulo sólo si es un doble (*.fake.ts).',
  severity: 'error',
  from: { path: '^src/modules/([^/]+)/.+\\.test\\.ts$' },
  to: {
    path: '^src/modules/[^/]+/infrastructure/',
    pathNot: ['^src/modules/$1/', '\\.fake\\.ts$'],
  },
},
```

y haz que las reglas de producción existentes ignoren los tests (`pathNot: '\\.test\\.ts$'` en su `from`). Añade a `test/architecture/dependency-rules.test.ts` un caso que provoca la violación (un test importando `mail/infrastructure/templates` desde `guests`) y espera el nombre de la regla. Arregla la violación real conocida: `invitation.processor.test.ts` importa `renderGuestInvitation` de `mail/infrastructure/templates`; pásalo a usar el puerto `INVITATION_RENDERER` con un doble local.

Run: `npm run lint` → sin violaciones; el test de arquitectura → PASS.

- [ ] **Step 2: ESLint de 25 avisos a 0**

- `test/architecture/dependency-rules.test.ts`: las 22 escrituras son a rutas bajo un directorio temporal; construye las rutas con una función `rutaTemporal(...partes)` que valide que el resultado queda dentro del directorio temporal, y anota ESA función con un único `// eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta validada dentro del temporal` por llamada al sistema de ficheros. Si el plugin sigue avisando, usa un `/* eslint-disable security/detect-non-literal-fs-filename */` al principio del fichero con el motivo: es un test que escribe a un temporal propio.
- `auth.controller.ts`: los dos `detect-possible-timing-attacks` son comparaciones con `undefined`, y el `detect-object-injection` es `cookies?.[COOKIE_REFRESH]` con una constante: `// eslint-disable-next-line <regla> -- <motivo concreto>` en cada una.
- Las tres directivas inútiles: bórralas.

Run: `npx eslint .` → `0 problems`.

- [ ] **Step 3: Tests que faltan**

- `register.use-case.test.ts`: registra, normaliza el email, encola `verify-email` con jobId sin `:`, y un email repetido lanza el error de email ya registrado.
- `logout.use-case.test.ts`: con un refresh válido revoca su familia; con uno desconocido o ya revocado no lanza.
- `notification.repository.paridad.test.ts`: los mismos casos (listar paginado, `unreadCount`, marcar leída idempotente, notificación de otro usuario → no encontrada) sobre Prisma (Testcontainers) y sobre el doble.
- `prisma-guest.repository.test.ts`: el caso de equivalencia doble/Prisma se repite con un cursor no nulo.

- [ ] **Step 4: Tests que no prueban lo que dicen**

- Parte `list-guests.use-case.test.ts` en un fichero por caso de uso (`list-guests`, `create-guest`, `update-guest`, `delete-guest`).
- Smoke de SIGTERM: afirma algo que sólo produce un cierre ordenado. Registra en `main.ts` un `app.get(Logger)`/pino `log` en `onApplicationShutdown` de un proveedor pequeño (`'Cierre ordenado completado'`), y el smoke exige esa línea en el stdout del proceso antes de salir. Mutación: quitar `enableShutdownHooks()` → el smoke falla.

- [ ] **Step 5: Verificación final — 10 ejecuciones**

Run: `npm run typecheck`, `npm run lint` (0 avisos), `npx prettier --check .`, `npm run build && npm run test:smoke`.
Run: `npm test` DIEZ veces seguidas.
Expected: las diez en verde. Cita el recuento de cada una. Si alguna falla, cita el test y la salida y NO lo des por hecho.

- [ ] **Step 6: Commit**

```bash
git add -A .dependency-cruiser.cjs test/ src/ eslint.config.mjs
git commit -m "chore: gates sin avisos, tests bajo la regla de dependencias y cobertura pendiente"
```
