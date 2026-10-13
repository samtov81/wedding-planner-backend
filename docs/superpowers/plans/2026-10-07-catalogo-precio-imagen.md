# Catálogo de proveedores con precio e imagen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cada ítem de `GET /vendors` traiga `currency`, `priceFrom` e `imageUrl`, calculados con las mismas reglas que `similar` en la ficha pública.

**Architecture:** El repositorio del catálogo (`PerfilDeCatalogo`) gana `currency`, `priceFrom` e `imageKey` (la **key** de R2, nunca una URL), traídos en la misma consulta que ya pagina. El caso de uso `SearchVendorCatalogUseCase` inyecta `SubidaDeImagenes` —lo mismo que `GetPublicVendorProfileUseCase`— y firma `imageKey → imageUrl` en paralelo, devolviendo una vista nueva `CatalogoVista` sin `imageKey` ni `createdAt`. El controlador mapea `CatalogoVista` a la respuesta.

**Tech Stack:** NestJS 11, Prisma 6 / PostgreSQL 16, Zod, Vitest + swc, Testcontainers (paridad y e2e), `@aws-sdk/s3-request-presigner` (firma local, sin red).

**Spec:** `docs/superpowers/specs/2026-10-07-catalogo-precio-imagen-design.md`

## Global Constraints

- Rama `feat/catalogo-precio-imagen` (ya creada desde `develop`); PR contra `develop`.
- No tocar las modificaciones previas de `.claude/settings.json`, `.gitignore` ni el `CLAUDE.md` sin seguimiento: nunca `git add -A` ni `git add .`; añadir ficheros por nombre.
- Respuesta: `{ items: { id, businessName, category: { slug, name }, specialty, currency, priceFrom, imageUrl }[], nextCursor: string | null }`.
- `currency: string` — moneda de la ficha (ISO 4217).
- `priceFrom: string | null` — precio del paquete más barato (`precioDesde`); `null` sin paquetes.
- `imageUrl: string | null` — primera foto del portfolio por su orden, firmada con `SubidaDeImagenes.firmarLectura`; `null` sin fotos.
- Sin cambios en filtros (`q`, `category`), cursor, `limit`, orden, límite de ritmo (`LIMITADOR_VENDOR_CATALOG`) ni en "sólo fichas `PUBLISHED`". Sin migración.
- Sólo se **añaden** claves a la respuesta.
- El repositorio devuelve la key, nunca una URL: firmar es decisión del caso de uso (las URLs caducan). Sin N+1.
- Regla de dependencia (dependency-cruiser): `application/` sólo mira a `domain/` (y a puertos públicos de otros módulos); un test de `vendors` sólo usa de `storage` su `*.fake.ts` (`ObjectStorageEnMemoria`) y su puerto público (`SubidaDeImagenes`).
- Comentarios, docblocks y nombres de `describe`/`it` en español; Prettier sin punto y coma, comillas simples, ancho 100.
- Gates por tarea: `npx vitest run <ficheros>`, `npm run typecheck`, `npm run lint`, `npx prettier --check .` (si falla, `npx prettier --write <ficheros tocados>` y volver a comprobar).
- Commits en español, terminando con una línea en blanco y `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Precios con distinto número de cifras (`'10000.00'` frente a `'9000.00'`): el mínimo es numérico (céntimos), no lexicográfico; Prisma y el doble deben coincidir. → paridad en Task 1 (ficha "Banquetes Sol") y unitario en Task 2.
- Varias fotos cuyo `position` no sigue el orden de inserción: gana la de menor `position` (empate: menor `id`), igual que la ficha pública. → paridad en Task 1 (ficha "Lumière Catering").
- Despliegue sin R2 (`SinAlmacenamiento`, `firmarLectura` → `null`): una ficha con fotos sale con `imageUrl: null`, sin 500. → unitario en Task 2 (`SinFirmaDeLectura`).
- Fuga de datos internos: la respuesta no debe llevar `imageKey` (key de R2) ni `createdAt`. → `toEqual` exacto en el unitario de Task 2 y en el e2e de Task 3.
- Paginación tras firmar en paralelo: `Promise.all` conserva el orden de los ítems y el `nextCursor` del repositorio llega intacto. → unitario en Task 2 (`limit: 1`).

---

## File Structure

```
src/modules/vendors/application/vendor-catalog.repository.ts           PerfilDeCatalogo gana currency, priceFrom, imageKey
src/modules/vendors/infrastructure/prisma-vendor-catalog.repository.ts select de moneda, precios y primera foto (take: 1)
src/modules/vendors/infrastructure/vendor-catalog.repository.fake.ts   PerfilEnMemoria (precios + fotos con position) y derivación
src/modules/vendors/infrastructure/vendor-catalog.repository.paridad.test.ts  siembra paquetes/fotos y compara los campos nuevos
src/modules/vendors/application/search-vendor-catalog.use-case.ts      CatalogoVista + firma con SubidaDeImagenes
src/modules/vendors/application/search-vendor-catalog.use-case.test.ts fixture nuevo + casos de firma, nulls y cursor
src/modules/vendors/interfaces/vendor-catalog.controller.ts            mapea CatalogoVista a la respuesta
test/e2e/vendor-catalog.e2e.test.ts                                    forma de la respuesta con R2 de pega (firma local)
```

`vendors.module.ts` no cambia: `SubidaDeImagenes` ya llega por `StorageModule` (importado y exportado), y `SearchVendorCatalogUseCase` ya es provider.

---

### Task 1: el repositorio del catálogo trae moneda, precio desde y key de la primera foto

**Files:**
- Modify: `src/modules/vendors/application/vendor-catalog.repository.ts:5-11`
- Modify: `src/modules/vendors/infrastructure/prisma-vendor-catalog.repository.ts`
- Modify: `src/modules/vendors/infrastructure/vendor-catalog.repository.fake.ts`
- Modify: `src/modules/vendors/application/search-vendor-catalog.use-case.test.ts` (sólo el fixture, para que compile)
- Test: `src/modules/vendors/infrastructure/vendor-catalog.repository.paridad.test.ts`

**Interfaces:**
- Consumes: `precioDesde(paquetes: readonly Pick<Paquete, 'price'>[]): string | null` de `src/modules/vendors/domain/vendor-profile.ts`.
- Produces:
  ```ts
  // application/vendor-catalog.repository.ts
  export interface PerfilDeCatalogo {
    id: string
    businessName: string
    category: CategoriaVista
    specialty: string | null
    currency: string
    priceFrom: string | null
    imageKey: string | null
    createdAt: Date
  }
  // infrastructure/vendor-catalog.repository.fake.ts
  export interface FotoEnMemoria { id: string; storageKey: string; position: number }
  export interface PerfilEnMemoria extends Omit<PerfilDeCatalogo, 'priceFrom' | 'imageKey'> {
    status: 'DRAFT' | 'PUBLISHED' | 'SUSPENDED'
    precios: string[]
    fotos: FotoEnMemoria[]
  }
  // VendorCatalogRepositoryEnMemoria.perfiles: PerfilEnMemoria[]
  ```

- [ ] **Step 1: Test de paridad (falla)**

Sustituir el contenido de `src/modules/vendors/infrastructure/vendor-catalog.repository.paridad.test.ts` por:

```ts
import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { decodeCursor } from '@/shared/domain'

import { categoriaId } from '../../../../test/support/categorias'
import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { VendorCatalogRepository } from '../application/vendor-catalog.repository'
import {
  type FotoEnMemoria,
  VendorCatalogRepositoryEnMemoria,
} from './vendor-catalog.repository.fake'
import { categoriaSembrada } from './vendor-category.repository.fake'
import { PrismaVendorCatalogRepository } from './prisma-vendor-catalog.repository'

const BASE = new Date('2026-03-01T00:00:00.000Z')

/**
 * Cada caso corre contra el doble y contra Postgres y compara lo que devuelve
 * el puerto (misma estructura que la paridad de eventos, Tarea 6).
 */
describe('Paridad: VendorCatalogRepositoryEnMemoria vs PrismaVendorCatalogRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let real: PrismaVendorCatalogRepository
  let doble: VendorCatalogRepositoryEnMemoria

  async function sembrar(
    n: number,
    datos: {
      businessName: string
      /** `slug` de la categoría. */
      category: string
      specialty?: string
      status?: 'DRAFT' | 'PUBLISHED' | 'SUSPENDED'
      /** Sin ella, la de la columna (`USD`). */
      currency?: string
      /** Precio de cada paquete, en el orden en que se crean. */
      precios?: string[]
      /** Fotos en el orden en que se INSERTAN; `position` decide cuál es la primera. */
      fotos?: Array<{ storageKey: string; position: number }>
    },
  ) {
    const user = await prisma.user.create({
      data: { email: `v${n}@catalogo.test`, passwordHash: 'x', fullName: `V${n}` },
    })
    const createdAt = new Date(BASE.getTime() + n * 60_000)
    const fila = await prisma.vendorProfile.create({
      data: {
        userId: user.id,
        businessName: datos.businessName,
        categoryId: await categoriaId(prisma, datos.category),
        specialty: datos.specialty ?? null,
        status: datos.status ?? 'PUBLISHED',
        ...(datos.currency !== undefined ? { currency: datos.currency } : {}),
        createdAt,
      },
    })
    const precios = datos.precios ?? []
    await prisma.vendorPackage.createMany({
      data: precios.map((price, position) => ({
        vendorProfileId: fila.id,
        name: `Paquete ${position}`,
        description: 'Descripción',
        price,
        position,
      })),
    })
    const fotos: FotoEnMemoria[] = []
    for (const foto of datos.fotos ?? []) {
      const creada = await prisma.vendorPortfolioImage.create({
        data: { vendorProfileId: fila.id, alt: 'Foto', ...foto },
      })
      fotos.push({ id: creada.id, storageKey: creada.storageKey, position: creada.position })
    }
    const { slug, name } = categoriaSembrada(datos.category)
    doble.perfiles.push({
      id: fila.id,
      businessName: datos.businessName,
      category: { slug, name },
      specialty: datos.specialty ?? null,
      currency: fila.currency,
      status: datos.status ?? 'PUBLISHED',
      createdAt,
      precios,
      fotos,
    })
  }

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    real = new PrismaVendorCatalogRepository(prisma as unknown as PrismaService)
    doble = new VendorCatalogRepositoryEnMemoria()

    // Varios paquetes y dos fotos insertadas al revés de su `position`.
    await sembrar(1, {
      businessName: 'Lumière Catering',
      category: 'catering',
      currency: 'EUR',
      precios: ['4500.00', '1200.50', '9000.00'],
      fotos: [
        { storageKey: 'users/v1/portfolio/segunda.jpg', position: 1 },
        { storageKey: 'users/v1/portfolio/primera.jpg', position: 0 },
      ],
    })
    // Ni paquetes ni fotos.
    await sembrar(2, {
      businessName: 'Foto Luz',
      category: 'photography',
      specialty: 'Bodas al aire libre',
    })
    await sembrar(3, {
      businessName: 'Oculto',
      category: 'catering',
      status: 'DRAFT',
      precios: ['10.00'],
      fotos: [{ storageKey: 'users/v3/portfolio/oculta.jpg', position: 0 }],
    })
    await sembrar(4, { businessName: 'Suspendido', category: 'catering', status: 'SUSPENDED' })
    // '10000.00' < '9000.00' como texto: el mínimo tiene que ser numérico.
    await sembrar(5, {
      businessName: 'Banquetes Sol',
      category: 'catering',
      precios: ['10000.00', '9000.00'],
      fotos: [{ storageKey: 'users/v5/portfolio/unica.jpg', position: 0 }],
    })
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  it.each([
    [{ q: null, category: null }, ['Lumière Catering', 'Foto Luz', 'Banquetes Sol']],
    [{ q: 'LUZ', category: null }, ['Foto Luz']],
    [{ q: 'aire libre', category: null }, ['Foto Luz']],
    [{ q: null, category: 'catering' }, ['Lumière Catering', 'Banquetes Sol']],
    [{ q: null, category: 'photography' }, ['Foto Luz']],
    [{ q: null, category: 'no-existe' }, []],
  ] as const)('buscar(%o)', async (filtro, esperado) => {
    for (const repo of [real, doble] as VendorCatalogRepository[]) {
      const pagina = await repo.buscar({ ...filtro, cursor: null, limit: 20 })
      expect(pagina.items.map((p) => p.businessName)).toEqual(esperado)
      expect(pagina.nextCursor).toBeNull()
    }
  })

  it('pagina con cursor sin saltos ni repetidos', async () => {
    for (const repo of [real, doble] as VendorCatalogRepository[]) {
      const p1 = await repo.buscar({ q: null, category: null, cursor: null, limit: 2 })
      expect(p1.items.map((p) => p.businessName)).toEqual(['Lumière Catering', 'Foto Luz'])
      expect(p1.nextCursor).not.toBeNull()
      const p2 = await repo.buscar({
        q: null,
        category: null,
        cursor: decodeCursor(p1.nextCursor ?? ''),
        limit: 2,
      })
      expect(p2.items.map((p) => p.businessName)).toEqual(['Banquetes Sol'])
      expect(p2.nextCursor).toBeNull()
    }
  })

  it('trae la moneda, el paquete más barato y la key de la primera foto por su orden', async () => {
    for (const repo of [real, doble] as VendorCatalogRepository[]) {
      const pagina = await repo.buscar({ q: null, category: null, cursor: null, limit: 20 })
      expect(
        pagina.items.map(({ businessName, currency, priceFrom, imageKey }) => ({
          businessName,
          currency,
          priceFrom,
          imageKey,
        })),
      ).toEqual([
        {
          businessName: 'Lumière Catering',
          currency: 'EUR',
          priceFrom: '1200.50',
          imageKey: 'users/v1/portfolio/primera.jpg',
        },
        { businessName: 'Foto Luz', currency: 'USD', priceFrom: null, imageKey: null },
        {
          businessName: 'Banquetes Sol',
          currency: 'USD',
          priceFrom: '9000.00',
          imageKey: 'users/v5/portfolio/unica.jpg',
        },
      ])
    }
  })
})
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `npx vitest run src/modules/vendors/infrastructure/vendor-catalog.repository.paridad.test.ts`
Expected: FAIL en `trae la moneda, el paquete más barato…` (el repositorio real devuelve los ítems sin `currency`, `priceFrom` ni `imageKey`: `undefined` frente a lo esperado). Los demás casos siguen en verde.

- [ ] **Step 3: Ampliar el puerto**

En `src/modules/vendors/application/vendor-catalog.repository.ts`, sustituir la interfaz `PerfilDeCatalogo` por:

```ts
/**
 * Un ítem del catálogo tal como lo guarda la base. `imageKey` es la key de
 * almacenamiento de la primera foto del portfolio, NUNCA una URL: firmarla es
 * decisión del caso de uso, porque la URL caduca y el repositorio no sabe
 * cuándo se va a pintar. `currency` y `priceFrom` siguen las mismas reglas
 * que `similar` en la ficha pública (`aSimilar`, `ficha-vista.ts`).
 */
export interface PerfilDeCatalogo {
  id: string
  businessName: string
  category: CategoriaVista
  specialty: string | null
  /** Moneda de la ficha (ISO 4217). */
  currency: string
  /** El paquete más barato (`precioDesde`); `null` sin paquetes. */
  priceFrom: string | null
  /** Primera foto por `position` (empate: `id`), como la ficha; `null` sin fotos. */
  imageKey: string | null
  createdAt: Date
}
```

- [ ] **Step 4: Implementar en Prisma**

En `src/modules/vendors/infrastructure/prisma-vendor-catalog.repository.ts`:

1. Añadir el import del dominio debajo del bloque de `../application/vendor-catalog.repository`:

```ts
import { precioDesde } from '../domain/vendor-profile'
```

2. Sustituir desde `// Uno de más para saber…` hasta el `return { … }` final por:

```ts
    // Uno de más para saber si hay página siguiente sin un COUNT aparte.
    // Paquetes y primera foto van en la MISMA consulta (Prisma los resuelve
    // con un IN por relación, no una consulta por ficha): sin N+1.
    const filas = await this.prisma.vendorProfile.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        businessName: true,
        category: { select: { slug: true, name: true } },
        specialty: true,
        currency: true,
        createdAt: true,
        packages: { select: { price: true } },
        // El mismo orden que `CON_HIJOS` en `prisma-vendor-profile.repository.ts`:
        // "la primera foto" del catálogo es la primera de la ficha.
        portfolioImages: {
          select: { storageKey: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          take: 1,
        },
      },
    })
    const items: PerfilDeCatalogo[] = filas.slice(0, limit).map((f) => ({
      id: f.id,
      businessName: f.businessName,
      category: f.category,
      specialty: f.specialty,
      currency: f.currency,
      // Mismo formato que la ficha ("4500.00") y la misma regla de mínimo.
      priceFrom: precioDesde(f.packages.map((p) => ({ price: p.price.toFixed(2) }))),
      imageKey: f.portfolioImages[0]?.storageKey ?? null,
      createdAt: f.createdAt,
    }))
    const ultimo = items.at(-1)
    return {
      items,
      nextCursor:
        filas.length > limit && ultimo !== undefined
          ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id })
          : null,
    }
```

- [ ] **Step 5: Implementar en el doble**

Sustituir el contenido de `src/modules/vendors/infrastructure/vendor-catalog.repository.fake.ts` por:

```ts
import { encodeCursor, type CursorPage } from '@/shared/domain'

import type {
  BusquedaCatalogo,
  PerfilDeCatalogo,
  VendorCatalogRepository,
} from '../application/vendor-catalog.repository'
import { precioDesde } from '../domain/vendor-profile'

export interface FotoEnMemoria {
  id: string
  storageKey: string
  position: number
}

/**
 * Lo que el doble guarda: los datos de partida (precios y fotos con su
 * `position`), no los derivados. Así la paridad prueba que Prisma y el doble
 * DERIVAN igual `priceFrom` e `imageKey`, en vez de comparar un valor que el
 * test escribió a mano en ambos lados.
 */
export interface PerfilEnMemoria extends Omit<PerfilDeCatalogo, 'priceFrom' | 'imageKey'> {
  status: 'DRAFT' | 'PUBLISHED' | 'SUSPENDED'
  /** Precio de cada paquete, normalizado ("4500.00"). */
  precios: string[]
  fotos: FotoEnMemoria[]
}

/** La primera foto por `position` y, a igual `position`, por `id` (como Prisma). */
function primeraFoto(fotos: readonly FotoEnMemoria[]): FotoEnMemoria | undefined {
  return [...fotos].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))[0]
}

function aPerfil({ status: _s, precios, fotos, ...perfil }: PerfilEnMemoria): PerfilDeCatalogo {
  return {
    ...perfil,
    priceFrom: precioDesde(precios.map((price) => ({ price }))),
    imageKey: primeraFoto(fotos)?.storageKey ?? null,
  }
}

export class VendorCatalogRepositoryEnMemoria implements VendorCatalogRepository {
  readonly perfiles: PerfilEnMemoria[] = []

  buscar(busqueda: BusquedaCatalogo): Promise<CursorPage<PerfilDeCatalogo>> {
    const q = busqueda.q?.toLowerCase() ?? null
    const categoria = busqueda.category
    const { cursor } = busqueda
    const candidatos = this.perfiles
      .filter((p) => p.status === 'PUBLISHED')
      .filter((p) => categoria === null || p.category.slug === categoria)
      .filter(
        (p) =>
          q === null ||
          p.businessName.toLowerCase().includes(q) ||
          (p.specialty?.toLowerCase().includes(q) ?? false),
      )
      .filter(
        (p) =>
          cursor === null ||
          p.createdAt.getTime() > cursor.createdAt.getTime() ||
          (p.createdAt.getTime() === cursor.createdAt.getTime() && p.id > cursor.id),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))

    const items = candidatos.slice(0, busqueda.limit).map(aPerfil)
    const ultimo = items.at(-1)
    const nextCursor =
      candidatos.length > busqueda.limit && ultimo !== undefined
        ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id })
        : null
    return Promise.resolve({ items, nextCursor })
  }
}
```

- [ ] **Step 6: Adaptar el fixture del unitario existente**

En `src/modules/vendors/application/search-vendor-catalog.use-case.test.ts`, a cada uno de los tres objetos de `catalogo.perfiles.push(...)` añadirle, después de `status: …,`:

```ts
        currency: 'USD',
        precios: [],
        fotos: [],
```

(Sin esto `PerfilEnMemoria` no compila. La Task 2 reescribe el fichero entero.)

- [ ] **Step 7: Ejecutar y ver que pasa**

Run: `npx vitest run src/modules/vendors/infrastructure/vendor-catalog.repository.paridad.test.ts src/modules/vendors/application/search-vendor-catalog.use-case.test.ts`
Expected: PASS (9 tests: 8 de paridad + 1 unitario).

- [ ] **Step 8: Gates**

Run: `npm run typecheck && npm run lint && npx prettier --check .`
Expected: sin errores. (El controlador sigue compilando: sólo desestructura `id`, `businessName`, `category`, `specialty`.)

- [ ] **Step 9: Commit**

```bash
git add src/modules/vendors/application/vendor-catalog.repository.ts \
  src/modules/vendors/infrastructure/prisma-vendor-catalog.repository.ts \
  src/modules/vendors/infrastructure/vendor-catalog.repository.fake.ts \
  src/modules/vendors/infrastructure/vendor-catalog.repository.paridad.test.ts \
  src/modules/vendors/application/search-vendor-catalog.use-case.test.ts
git commit -m "$(cat <<'EOF'
feat: el repositorio del catálogo trae moneda, precio desde y key de la primera foto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: el caso de uso firma la imagen y devuelve `CatalogoVista`

**Files:**
- Modify: `src/modules/vendors/application/search-vendor-catalog.use-case.ts`
- Test: `src/modules/vendors/application/search-vendor-catalog.use-case.test.ts`

**Interfaces:**
- Consumes: `PerfilDeCatalogo` (Task 1, con `currency`, `priceFrom`, `imageKey`); `PerfilEnMemoria`, `VendorCatalogRepositoryEnMemoria` (Task 1); `SubidaDeImagenes.firmarLectura(key: string): Promise<string | null>` (`@/modules/storage/application/subida-de-imagenes`); `ObjectStorageEnMemoria` (`@/modules/storage/infrastructure/object-storage.fake`, firma como `https://almacen.test/get/<key>`).
- Produces:
  ```ts
  // application/search-vendor-catalog.use-case.ts
  export interface CatalogoVista {
    id: string
    businessName: string
    category: CategoriaVista
    specialty: string | null
    currency: string
    priceFrom: string | null
    imageUrl: string | null
  }
  // constructor(catalogo: VendorCatalogRepository, imagenes: SubidaDeImagenes)
  // ejecutar(busqueda: BusquedaCatalogo): Promise<CursorPage<CatalogoVista>>
  ```

- [ ] **Step 1: Tests del caso de uso (fallan)**

Sustituir el contenido de `src/modules/vendors/application/search-vendor-catalog.use-case.test.ts` por:

```ts
import { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'
import { ObjectStorageEnMemoria } from '@/modules/storage/infrastructure/object-storage.fake'

import {
  type PerfilEnMemoria,
  VendorCatalogRepositoryEnMemoria,
} from '../infrastructure/vendor-catalog.repository.fake'
import { SearchVendorCatalogUseCase } from './search-vendor-catalog.use-case'

/** Un despliegue sin R2: lo guardado sale sin URL (como `SinAlmacenamiento`). */
class SinFirmaDeLectura extends ObjectStorageEnMemoria {
  override firmarLectura(): Promise<string | null> {
    return Promise.resolve(null)
  }
}

const BASE = Date.parse('2026-03-01T00:00:00.000Z')
const SIN_FILTROS = { q: null, category: null, cursor: null, limit: 20 }

/** `perfil(1)` → id `11111111-1111-4111-8111-111111111111`, creado un minuto tras BASE. */
function perfil(n: number, datos: Partial<PerfilEnMemoria> = {}): PerfilEnMemoria {
  const d = String(n)
  return {
    id: `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`,
    businessName: `Proveedor ${n}`,
    category: { slug: 'catering', name: 'Catering' },
    specialty: null,
    currency: 'USD',
    createdAt: new Date(BASE + n * 60_000),
    status: 'PUBLISHED',
    precios: [],
    fotos: [],
    ...datos,
  }
}

function montar(storage: ObjectStorageEnMemoria = new ObjectStorageEnMemoria()) {
  const catalogo = new VendorCatalogRepositoryEnMemoria()
  const caso = new SearchVendorCatalogUseCase(catalogo, new SubidaDeImagenes(storage))
  return { catalogo, caso }
}

describe('SearchVendorCatalogUseCase', () => {
  it('solo devuelve los perfiles publicados', async () => {
    const { catalogo, caso } = montar()
    catalogo.perfiles.push(
      perfil(1, { businessName: 'Lumière Catering' }),
      perfil(2, {
        businessName: 'Foto Luz',
        category: { slug: 'photography', name: 'Photography' },
      }),
      perfil(3, { businessName: 'Oculto', status: 'DRAFT' }),
    )

    const pagina = await caso.ejecutar(SIN_FILTROS)

    expect(pagina.items.map((p) => p.businessName)).toEqual(['Lumière Catering', 'Foto Luz'])
    expect(pagina.nextCursor).toBeNull()
  })

  it('firma la key de la primera foto y devuelve la vista sin imageKey ni createdAt', async () => {
    const { catalogo, caso } = montar()
    catalogo.perfiles.push(
      perfil(1, {
        businessName: 'Lumière Catering',
        currency: 'EUR',
        precios: ['10000.00', '9000.00', '4500.50'],
        fotos: [
          { id: 'b', storageKey: 'users/u1/portfolio/segunda.jpg', position: 1 },
          { id: 'a', storageKey: 'users/u1/portfolio/primera.jpg', position: 0 },
        ],
      }),
    )

    const { items } = await caso.ejecutar(SIN_FILTROS)

    expect(items).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        businessName: 'Lumière Catering',
        category: { slug: 'catering', name: 'Catering' },
        specialty: null,
        currency: 'EUR',
        priceFrom: '4500.50',
        imageUrl: 'https://almacen.test/get/users/u1/portfolio/primera.jpg',
      },
    ])
  })

  it('sin paquetes ni fotos → priceFrom e imageUrl a null; currency pasa tal cual', async () => {
    const { catalogo, caso } = montar()
    catalogo.perfiles.push(perfil(1, { currency: 'MXN' }))

    const [item] = (await caso.ejecutar(SIN_FILTROS)).items

    expect(item).toMatchObject({ currency: 'MXN', priceFrom: null, imageUrl: null })
  })

  it('sin almacenamiento, una ficha con fotos sale con imageUrl null sin fallar', async () => {
    const { catalogo, caso } = montar(new SinFirmaDeLectura())
    catalogo.perfiles.push(
      perfil(1, { fotos: [{ id: 'a', storageKey: 'users/u1/portfolio/a.jpg', position: 0 }] }),
    )

    const [item] = (await caso.ejecutar(SIN_FILTROS)).items

    expect(item?.imageUrl).toBeNull()
  })

  it('conserva el orden de los ítems y el cursor de la página', async () => {
    const { catalogo, caso } = montar()
    catalogo.perfiles.push(
      perfil(1, { fotos: [{ id: 'a', storageKey: 'users/u1/portfolio/a.jpg', position: 0 }] }),
      perfil(2),
      perfil(3, { fotos: [{ id: 'c', storageKey: 'users/u3/portfolio/c.jpg', position: 0 }] }),
    )

    const p1 = await caso.ejecutar({ ...SIN_FILTROS, limit: 2 })

    expect(p1.items.map((p) => p.imageUrl)).toEqual([
      'https://almacen.test/get/users/u1/portfolio/a.jpg',
      null,
    ])
    expect(p1.nextCursor).not.toBeNull()
  })
})
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `npx vitest run src/modules/vendors/application/search-vendor-catalog.use-case.test.ts`
Expected: FAIL en los casos de `imageUrl` (el caso de uso devuelve `PerfilDeCatalogo` tal cual: trae `imageKey` y `createdAt` y no `imageUrl`). `solo devuelve los perfiles publicados` pasa.

- [ ] **Step 3: Implementar el caso de uso**

Sustituir el contenido de `src/modules/vendors/application/search-vendor-catalog.use-case.ts` por:

```ts
import { Inject, Injectable } from '@nestjs/common'

import { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'
import type { CursorPage } from '@/shared/domain'

import type { CategoriaVista } from '../domain/categoria'
import {
  type BusquedaCatalogo,
  type PerfilDeCatalogo,
  VENDOR_CATALOG_REPOSITORY,
  type VendorCatalogRepository,
} from './vendor-catalog.repository'

/**
 * Un ítem del catálogo tal como se pinta en la tarjeta del marketplace.
 *
 * Hoy tiene la misma forma que `SimilarVista` (`ficha-vista.ts`) y se calcula
 * con las mismas reglas, pero es un tipo propio a propósito: un alias ataría
 * el catálogo a lo que la ficha decida añadir a sus "similares" (y al revés).
 * Sin `imageKey` (es la key de R2, no algo que el cliente deba ver) ni
 * `createdAt` (sólo sirve para el cursor, que ya va codificado).
 */
export interface CatalogoVista {
  id: string
  businessName: string
  category: CategoriaVista
  specialty: string | null
  currency: string
  priceFrom: string | null
  /** Primera foto del portfolio, prefirmada y de vida corta; `null` sin fotos o sin almacenamiento. */
  imageUrl: string | null
}

@Injectable()
export class SearchVendorCatalogUseCase {
  /**
   * `SubidaDeImagenes` es lo mismo que inyecta `GetPublicVendorProfileUseCase`
   * para firmar: `StorageModule` lo exporta como su puerto público, así que
   * aquí no entra nada de `storage/infrastructure`.
   */
  constructor(
    @Inject(VENDOR_CATALOG_REPOSITORY) private readonly catalogo: VendorCatalogRepository,
    private readonly imagenes: SubidaDeImagenes,
  ) {}

  /**
   * Solo búsqueda: el marketplace completo (reseñas, ubicación) queda fuera de
   * alcance. Las URLs se firman aquí y no en el repositorio porque caducan:
   * firmar es decidir cuándo se va a pintar, y eso es del caso de uso. Las
   * firmas de la página van en paralelo (`Promise.all` conserva el orden).
   */
  async ejecutar(busqueda: BusquedaCatalogo): Promise<CursorPage<CatalogoVista>> {
    const pagina = await this.catalogo.buscar(busqueda)
    return {
      items: await Promise.all(pagina.items.map((perfil) => this.aVista(perfil))),
      nextCursor: pagina.nextCursor,
    }
  }

  private async aVista(perfil: PerfilDeCatalogo): Promise<CatalogoVista> {
    return {
      id: perfil.id,
      businessName: perfil.businessName,
      category: perfil.category,
      specialty: perfil.specialty,
      currency: perfil.currency,
      priceFrom: perfil.priceFrom,
      imageUrl:
        perfil.imageKey === null ? null : await this.imagenes.firmarLectura(perfil.imageKey),
    }
  }
}
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `npx vitest run src/modules/vendors/application/search-vendor-catalog.use-case.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Gates**

Run: `npm run typecheck && npm run lint && npx prettier --check .`
Expected: sin errores. dependency-cruiser acepta `application → @/modules/storage/application/subida-de-imagenes` (ya lo hace `get-public-vendor-profile.use-case.ts`) y el test sólo toca de `storage` su `*.fake.ts`. El controlador sigue compilando (desestructura cuatro campos que `CatalogoVista` tiene).

- [ ] **Step 6: Commit**

```bash
git add src/modules/vendors/application/search-vendor-catalog.use-case.ts \
  src/modules/vendors/application/search-vendor-catalog.use-case.test.ts
git commit -m "$(cat <<'EOF'
feat: el catálogo firma la primera foto y devuelve CatalogoVista

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `GET /vendors` responde con `currency`, `priceFrom` e `imageUrl`

**Files:**
- Modify: `src/modules/vendors/interfaces/vendor-catalog.controller.ts`
- Test: `test/e2e/vendor-catalog.e2e.test.ts`

**Interfaces:**
- Consumes: `CatalogoVista` y `SearchVendorCatalogUseCase.ejecutar(busqueda): Promise<CursorPage<CatalogoVista>>` (Task 2).
- Produces: respuesta HTTP `{ items: CatalogoVista[]; nextCursor: string | null }`.

- [ ] **Step 1: E2E (falla)**

En `test/e2e/vendor-catalog.e2e.test.ts`:

1. Sustituir la interfaz `CuerpoCatalogo` por:

```ts
interface CuerpoCatalogo {
  items: Array<{
    id: string
    businessName: string
    category: { slug: string; name: string }
    specialty: string | null
    currency: string
    priceFrom: string | null
    imageUrl: string | null
  }>
  nextCursor: string | null
}

/**
 * R2 "de pega": firmar una URL de lectura es local (SigV4, sin red), así que
 * con las cuatro variables puestas la app usa `R2ObjectStorage` de verdad y
 * el e2e ve la URL firmada sin tocar ningún bucket. Cada fichero de test corre
 * en su propio proceso: esto no se filtra a `profile.e2e.test.ts`, que prueba
 * justo el caso sin R2.
 */
const R2_DE_PEGA = {
  R2_ENDPOINT: 'https://cuenta.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secreto',
  R2_BUCKET: 'fotos',
}
```

2. Junto a `let ana: …`, declarar:

```ts
  let lumiereUserId: string
  let lumiereId: string
  let jardinId: string
```

3. En `beforeAll`, cambiar `fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })` por:

```ts
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() }, R2_DE_PEGA)
```

4. En `beforeAll`, sustituir el bloque que crea `publicado` y su `vendorProfile` por:

```ts
    const publicado = await prisma.user.create({
      data: { email: 'lumiere@catalogo.test', passwordHash: 'x', fullName: 'Lumière' },
    })
    lumiereUserId = publicado.id
    const lumiere = await prisma.vendorProfile.create({
      data: {
        userId: publicado.id,
        businessName: 'Lumière',
        categoryId: await categoriaId(prisma, 'catering'),
        status: 'PUBLISHED',
        currency: 'EUR',
      },
    })
    lumiereId = lumiere.id
    await prisma.vendorPackage.createMany({
      data: [
        {
          vendorProfileId: lumiere.id,
          name: 'Completo',
          description: 'Todo incluido',
          price: '4500.00',
          position: 0,
        },
        {
          vendorProfileId: lumiere.id,
          name: 'Básico',
          description: 'Lo esencial',
          price: '1200.50',
          position: 1,
        },
      ],
    })
    await prisma.vendorPortfolioImage.create({
      data: {
        vendorProfileId: lumiere.id,
        storageKey: `users/${publicado.id}/portfolio/a.jpg`,
        alt: 'Mesa',
        position: 0,
      },
    })

    // Publicada, sin paquetes ni fotos; en `venue` para no tocar los filtros de abajo.
    const vacio = await prisma.user.create({
      data: { email: 'jardin@catalogo.test', passwordHash: 'x', fullName: 'Jardín' },
    })
    const jardin = await prisma.vendorProfile.create({
      data: {
        userId: vacio.id,
        businessName: 'Jardín Vacío',
        categoryId: await categoriaId(prisma, 'venue'),
        status: 'PUBLISHED',
      },
    })
    jardinId = jardin.id
```

(El bloque de `oculto` se queda como está, después.)

5. Añadir, después del caso `lista solo perfiles PUBLISHED y filtra por q`:

```ts
  it('cada ítem trae currency, priceFrom e imageUrl; sin paquetes ni fotos, null', async () => {
    const res = await request(url)
      .get('/vendors')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)
    const cuerpo = res.body as CuerpoCatalogo

    expect(cuerpo.nextCursor).toBeNull()
    // `toEqual` exacto: ni `imageKey` ni `createdAt` salen en la respuesta.
    expect(cuerpo.items).toEqual([
      {
        id: lumiereId,
        businessName: 'Lumière',
        category: { slug: 'catering', name: 'Catering' },
        specialty: null,
        currency: 'EUR',
        priceFrom: '1200.50',
        imageUrl: expect.any(String) as string,
      },
      {
        id: jardinId,
        businessName: 'Jardín Vacío',
        category: { slug: 'venue', name: 'Venue' },
        specialty: null,
        currency: 'USD',
        priceFrom: null,
        imageUrl: null,
      },
    ])
    const imageUrl = cuerpo.items[0]?.imageUrl ?? ''
    expect(imageUrl).toContain(`/users/${lumiereUserId}/portfolio/a.jpg?`)
    expect(imageUrl).toContain('X-Amz-Signature=')
  })
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `npx vitest run test/e2e/vendor-catalog.e2e.test.ts`
Expected: FAIL sólo en `cada ítem trae currency, priceFrom e imageUrl…` (el controlador aún responde con cuatro claves: faltan `currency`, `priceFrom`, `imageUrl`). Los demás casos pasan: `filtra por el slug de la categoría` sigue viendo sólo `Lumière` en `catering` y nada en `photography`.

- [ ] **Step 3: Mapear `CatalogoVista` en el controlador**

En `src/modules/vendors/interfaces/vendor-catalog.controller.ts`:

1. Sustituir las líneas

```ts
import { SearchVendorCatalogUseCase } from '../application/search-vendor-catalog.use-case'
import type { CategoriaVista } from '../domain/categoria'
import { vendorCatalogQuerySchema } from './vendor-catalog.dto'

interface PerfilRespuesta {
  id: string
  businessName: string
  category: CategoriaVista
  specialty: string | null
}
```

por

```ts
import {
  type CatalogoVista,
  SearchVendorCatalogUseCase,
} from '../application/search-vendor-catalog.use-case'
import { vendorCatalogQuerySchema } from './vendor-catalog.dto'
```

2. Cambiar el tipo de retorno de `buscarVendors` a `Promise<{ items: CatalogoVista[]; nextCursor: string | null }>`.

3. Sustituir el `items: pagina.items.map(...)` por:

```ts
      // Lista blanca explícita: si la vista gana un campo, salir por la API
      // es una decisión que se toma aquí, no un efecto de propagar el objeto.
      items: pagina.items.map(
        ({ id, businessName, category, specialty, currency, priceFrom, imageUrl }) => ({
          id,
          businessName,
          category,
          specialty,
          currency,
          priceFrom,
          imageUrl,
        }),
      ),
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `npx vitest run test/e2e/vendor-catalog.e2e.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Suite del módulo y gates**

Run: `npx vitest run src/modules/vendors test/e2e/vendor-catalog.e2e.test.ts test/e2e/profile.e2e.test.ts test/architecture && npm run typecheck && npm run lint && npx prettier --check .`
Expected: todo en verde (`profile.e2e.test.ts` confirma que el R2 de pega no se filtró a otro fichero).

- [ ] **Step 6: Commit**

```bash
git add src/modules/vendors/interfaces/vendor-catalog.controller.ts test/e2e/vendor-catalog.e2e.test.ts
git commit -m "$(cat <<'EOF'
feat: GET /vendors devuelve currency, priceFrom e imageUrl

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
