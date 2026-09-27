# Distribución de invitados en mesas (backend + frontend)

> Diseño aprobado en conversación el 2026-09-27. Ramas `feat/mesas` desde
> `main` en `wedding-planner-backend` y `wedding-planner-frontend`, con PR contra
> `main`.

## 1. Alcance

La pareja o el planner configuran las mesas del evento y sientan a cada
persona en un asiento concreto. La vista es gráfica: mesas redondas con sus
asientos alrededor, sobre un lienzo. En un panel lateral se elige la mesa, luego
una persona de la lista y luego un asiento; cada cambio se guarda al instante.

Decisiones del usuario:

- **Cada acompañante ocupa un asiento.** Una persona es `(guestId,
  companionIndex)`: `0` es el invitado y `1..n` sus acompañantes ("Acompañante
  1 de Ana"). Cada una puede ir en cualquier mesa.
- **Elegibles: todos menos los que rechazaron.** Plazas de un invitado =
  `1 + (companionsConfirmed ?? companionsAllowed)`; un PENDING reserva el cupo
  permitido.
- **Sobrantes marcados, no liberados.** Si un invitado sentado rechaza o baja
  sus acompañantes, sus asientos siguen ocupados y se devuelven con
  `sobrante: true` para que la pareja los resuelva. Borrar al invitado sí libera
  sus asientos (cascada).
- **Mín./máx. por mesa.** Cada mesa tiene `minSeats` y `maxSeats`. Nace con
  `minSeats` asientos y crece de a uno hasta `maxSeats`. Solo se quita el último
  asiento y solo si está vacío. Topes: `1 ≤ min ≤ asientos ≤ max ≤ 20`, a lo
  sumo 100 mesas por evento.
- **Generar N + editar.** `generate` agrega N mesas a continuación de las
  existentes ("Mesa 6", "Mesa 7"…). Luego cada mesa se edita, se agrega o se
  elimina por separado. Eliminar una mesa deja sin asignar a sus ocupantes.
- **Mesas redondas con nombre editable.**
- **Asignar intercambia.** Si el asiento está ocupado, los dos ocupantes se
  intercambian. Si la persona elegida ya estaba sentada, se mueve. Si no lo
  estaba, el ocupante anterior queda sin asignar.
- **Tres formas de interactuar:** el panel (mesa → persona → clic en asiento),
  arrastrar una persona a un asiento (sobre la mesa va al primer asiento
  libre) y arrastrar mesas, cuya posición se guarda.

Fuera de alcance: acompañantes con nombre propio, auto-asignación, zoom, mesas
rectangulares y edición en tiempo real entre varias personas.

## 2. Modelo de datos

Migración `20260927130000_add_seating`. Ver `docs/DATABASE.md`:

- `seating_tables`: `name, minSeats, maxSeats, seatCount, x, y`. CHECK
  `seating_tables_asientos_rango` y `seating_tables_posicion`.
- `seat_assignments`: `tableId, seatIndex, guestId, companionIndex`. Únicos
  `(tableId, seatIndex)` y `(guestId, companionIndex)`, CHECK
  `seat_assignments_indices`.

Las reglas que cruzan tablas (el asiento existe, la persona cabe, el tope de
mesas) se validan en los casos de uso tras bloquear la fila del evento
(`SELECT … FOR UPDATE`) dentro de una unidad de trabajo, para que dos
escrituras concurrentes no validen contra un estado que la otra está cambiando.

## 3. API

Todas bajo `/events/:eventId/seating`, con `@RequireEventAccess('COUPLE', 'PLANNER')`.

| Método | Ruta | Respuesta | Errores |
|---|---|---|---|
| GET | `/` | `{ tables }` | |
| POST | `/tables/generate` `{count, minSeats, maxSeats}` | 201 `{ tables }` | 422 `TABLE_LIMIT_EXCEEDED` |
| POST | `/tables` `{name?, minSeats, maxSeats}` | 201 mesa | 422 `TABLE_LIMIT_EXCEEDED` |
| PATCH | `/tables/:tableId` `{name?, minSeats?, maxSeats?, seatCount?, x?, y?}` | mesa | 404 `TABLE_NOT_FOUND`, 422 `TABLE_SEATS_OUT_OF_RANGE`, 409 `SEAT_NOT_EMPTY` |
| DELETE | `/tables/:tableId` | 204 | 404 |
| PUT | `/assignments` `{tableId, seatIndex, guestId, companionIndex}` | `{ tables }` | 404, 422 `SEAT_OUT_OF_RANGE`, 422 `SEAT_OCCUPANT_INVALID` |
| DELETE | `/tables/:tableId/seats/:seatIndex` | 204 | 404, 422 `SEAT_OUT_OF_RANGE` |

Mesa: `{ id, name, minSeats, maxSeats, seatCount, x, y, seats: [{ index,
occupant: { guestId, companionIndex, sobrante } | null }] }`.

Los nombres de los invitados no viajan aquí: el frontend ya los tiene con
`GET /events/:eventId/guests`.

## 4. Frontend

- `src/lib/api-client.ts` gana `apiPatch`, `apiPut` y `apiDelete`.
- `features/seating/` pasa de mocks a la API: `seating-model.ts`,
  `seating-api.ts`, asientos dibujados alrededor de la mesa, panel lateral y
  modales para generar y agregar mesas.
- Ruta `/events/:eventId/seating`.
