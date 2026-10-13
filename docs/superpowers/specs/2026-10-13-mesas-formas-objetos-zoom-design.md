# Mesas: formas, objetos de sala y zoom (backend + frontend)

> Revisión de `2026-09-27-mesas-design.md` pedida por el usuario el 2026-10-13.
> Rama `feat/mesas-formas-objetos` (backend) y `feat/mesas-formas-objetos-zoom`
> (frontend), con PR contra `develop`. Deja sin efecto el "Fuera de alcance" de
> aquel diseño en lo que se refiere al zoom y a las mesas rectangulares.

## 1. Contexto y decisiones

El editor de distribución sólo dibujaba mesas redondas. Se añaden mesas
rectangulares, objetos de sala (pista de baile, escenario...) y zoom.

Decisiones del usuario (backend):

- **Forma de la mesa:** `ROUND` o `RECTANGULAR`. Las mesas existentes pasan a
  `ROUND`. Se elige al crear (por defecto `ROUND`) y se puede cambiar después
  con PATCH. Cambiar la forma conserva las asignaciones: los asientos siguen
  siendo `0..seatCount-1`. `generate` crea siempre mesas `ROUND`.
- **Mismo rango de asientos para las dos formas:**
  `1 ≤ minSeats ≤ seatCount ≤ maxSeats ≤ 20`. Cómo se reparten los asientos por
  los lados es dibujo y vive sólo en el frontend; el backend no tiene reglas por
  forma, y no se deben añadir.
- **Objetos de sala:** tipos `DANCE_FLOOR`, `STAGE`, `BAR`, `DESSERT_TABLE`,
  `ENTRANCE`. Campos: `kind` (fijo tras crear), `label` (recortada, 1..60),
  `x`, `y` (enteros 0..10000). Sin asientos, sin tamaño, sin rotación. Máximo 30
  por evento, que aplica el caso de uso con el evento bloqueado, no la base de
  datos.

Decisiones del usuario (frontend):

- `SEAT_GAP` baja de 12 a 4 px.
- Mesa rectangular: asientos en los dos lados largos; si el número es impar, el
  asiento extra va arriba; numeración en sentido horario.
- Zoom del 50 % al 200 % en pasos de 10; no se persiste.
- Herramienta Seleccionar en modo único, con Esc para deseleccionar.
- Se quita el bloque fijo "Wedding Stage": el escenario es ahora un objeto.
- Los objetos tienen tamaño fijo según su tipo; no se rotan ni se redimensionan.
- Sigue fuera de alcance: Auto-Assign y Export PDF.

## 2. Modelo de datos

Migración `20261013120000_seating_shapes_and_objects`. Ver `docs/DATABASE.md`:

- `seating_tables.shape` (`SeatingTableShape`: `ROUND` | `RECTANGULAR`,
  `NOT NULL DEFAULT 'ROUND'`, lo que rellena las filas existentes).
- `seating_objects`: `kind` (`SeatingObjectKind`), `label`, `x`, `y`.
  Pertenece al evento con cascada. CHECK `seating_objects_posicion` y
  `seating_objects_etiqueta`.

## 3. API

Todas bajo `/events/:eventId/seating`, con
`@RequireEventAccess('COUPLE', 'PLANNER')` y sólo el límite de ritmo global.

| Método | Ruta | Respuesta | Errores |
|---|---|---|---|
| GET | `/` | `{ tables, objects }` (objetos en orden de creación) | |
| POST | `/tables` `{name?, shape?, minSeats, maxSeats}` | 201 mesa | 422 `TABLE_LIMIT_EXCEEDED` |
| PATCH | `/tables/:tableId` `{name?, shape?, minSeats?, maxSeats?, seatCount?, x?, y?}` | mesa | 404 `TABLE_NOT_FOUND`, 422 `TABLE_SEATS_OUT_OF_RANGE`, 409 `SEAT_NOT_EMPTY` |
| POST | `/tables/generate` | 201 `{ tables }` (siempre `ROUND`) | sin cambios |
| PUT | `/assignments` | `{ tables }` | sin cambios |
| POST | `/objects` `{kind, label, x, y}` | 201 objeto | 400, 422 `OBJECT_LIMIT_EXCEEDED` |
| PATCH | `/objects/:objectId` `{label?, x?, y?}` (al menos uno) | objeto | 400, 404 `OBJECT_NOT_FOUND` |
| DELETE | `/objects/:objectId` | 204 | 404 `OBJECT_NOT_FOUND` |

Mesa: `{ id, name, shape, minSeats, maxSeats, seatCount, x, y, seats }`.
Objeto: `{ id, kind, label, x, y }`. Los cuerpos son `.strict()`: un campo
desconocido (por ejemplo `kind` en el PATCH del objeto) es 400.
