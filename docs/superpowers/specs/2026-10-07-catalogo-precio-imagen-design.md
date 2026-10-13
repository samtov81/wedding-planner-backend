# Catálogo de proveedores con precio e imagen

> Diseño aprobado en conversación el 2026-10-07. Rama `feat/catalogo-precio-imagen`
> desde `develop` en `wedding-planner-backend`, PR contra `develop`. Lo consume
> la vista Proveedores del evento del frontend
> (`wedding-planner-frontend/docs/superpowers/specs/2026-10-07-proveedores-evento-design.md`).

## 1. Problema

La pestaña Marketplace de la vista Proveedores pinta tarjetas con foto y
precio "desde". `GET /vendors` sólo devuelve `id`, `businessName`, `category`
y `specialty`; la foto y el precio sólo existen en la ficha pública
(`GET /vendors/:vendorId`), que no se puede pedir por cada tarjeta (N
peticiones y límite de 60/min).

## 2. Decisión

Cada ítem de `GET /vendors` añade tres campos, calculados con **las mismas
reglas** que ya usa `similar` en la ficha pública (`aSimilar`,
`application/ficha-vista.ts`):

| Campo | Tipo | Regla |
|---|---|---|
| `currency` | `string` | Moneda de la ficha (ISO 4217). |
| `priceFrom` | `string \| null` | Precio del paquete más barato (`precioDesde`); `null` sin paquetes. |
| `imageUrl` | `string \| null` | Primera foto del portfolio por su orden, firmada con `SubidaDeImagenes.firmarLectura`; `null` sin fotos. |

Respuesta resultante:

```
{ items: { id, businessName, category: { slug, name }, specialty, currency, priceFrom, imageUrl }[],
  nextCursor: string | null }
```

Sin cambios en: filtros (`q`, `category`), cursor, `limit`, orden, límite de
ritmo (`LIMITADOR_VENDOR_CATALOG`), sólo fichas `PUBLISHED`. Sin migración:
todo sale de tablas existentes.

Compatibilidad: sólo se **añaden** claves. El frontend actual valida con zod,
que descarta las claves que no declara.

## 3. Diseño

- `PerfilDeCatalogo` (`application/vendor-catalog.repository.ts`) gana
  `currency: string`, `priceFrom: string | null` e `imageKey: string | null`.
  El repositorio devuelve la **key** de almacenamiento, nunca una URL: firmar
  es una decisión del caso de uso (las URLs caducan).
- `PrismaVendorCatalogRepository.buscar` trae en la misma consulta la moneda,
  los paquetes (sólo `price`) y la primera foto del portfolio (`take: 1` con el
  mismo orden que usa la ficha). Sin N+1. `priceFrom` se calcula reutilizando
  `precioDesde` (o la misma regla, si su firma no encaja con la proyección).
- `SearchVendorCatalogUseCase` inyecta el puerto de imágenes que ya usa
  `GetPublicVendorProfileUseCase` y firma `imageKey → imageUrl` para cada ítem
  (en paralelo). Devuelve una vista nueva `CatalogoVista` sin `imageKey` ni
  `createdAt`.
- El controlador mapea `CatalogoVista` a la respuesta.
- `vendor-catalog.repository.fake.ts` refleja los campos nuevos.

## 4. Tests

- Unitario del caso de uso (contra el fake y un firmador fake): firma la key
  de la primera foto; sin fotos → `imageUrl: null`; sin paquetes →
  `priceFrom: null`; `currency` pasa tal cual.
- Paridad (`vendor-catalog.repository.paridad.test.ts`): fake y Prisma
  devuelven el mismo `currency`, `priceFrom` e `imageKey` para fichas con y sin
  paquetes/fotos, y con varias fotos (gana la primera por orden).
- E2E del catálogo: la respuesta trae los tres campos con su forma; una ficha
  sin paquetes ni fotos da `null` en ambos.

## 5. Fuera de alcance

Ubicación, valoraciones y nº de bodas en el catálogo; ordenar por precio;
filtrar por rango de precio.
