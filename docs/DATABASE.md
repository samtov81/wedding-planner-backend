# Database Management

## Quick Reference

| Command | Purpose |
|---------|---------|
| `npm run db:generate` | Generate Prisma Client after schema changes |
| `npm run db:push` | Sync schema to database (dev only, no migrations) |
| `npm run db:studio` | Open Prisma Studio UI to browse data |
| `npm run db:migrate:dev` | Create and apply migration interactively |
| `npm run db:migrate:deploy` | Apply pending migrations (prod) |
| `npm run db:migrate:reset` | ⚠️ Reset database and reapply all migrations |
| `npm run db:seed` | Run seed script to populate test data |
| `npm run db:docker:migrate` | Apply migrations inside Docker containers |
| `npm run db:docker:reset` | Reset Docker volumes and restart services |

## Schema

### `events`

| Column | Notes |
|---|---|
| `status` | `EventStatus` (`DRAFT` \| `ACTIVE`), defaults to `DRAFT`. New events start as drafts; existing rows were backfilled to `ACTIVE` since they already had a mandatory `weddingDate`. |
| `weddingDate` | Nullable — a `DRAFT` event can exist without a date. |
| `currency` | `CHAR(3)`, defaults to `USD`. |
| `totalBudget` | `DECIMAL(12,2)`, nullable. |
| `venueName`, `venueAddress`, `venueLat`, `venueLng`, `venueMapboxId` | Venue fields. `venueAddress` replaces the old free-text `venueLocation` column (data was copied over during the migration). |
| `rsvpDeadlineDays` | Unchanged. |

CHECK constraints:
- `events_venue_coords` — `venueLat`/`venueLng` must be both present or both absent, and each must be within its valid range (`-90..90` / `-180..180`).
- `events_total_budget_no_negativo` — `totalBudget`, when set, cannot be negative.
- `events_activo_con_fecha` — an `ACTIVE` event must have a `weddingDate`; only `DRAFT` events can omit it.

### `event_budget_grants`

Belongs to an `EventMembership` (`membershipId` unique, `onDelete: Cascade`). A row means the event owner granted that member permission to **view** the budget (expenses, budget summary, the event's `totalBudget` and vendors' `assignedBudget`); no row means no access. Editing the budget is always reserved to the event owner, so there is no level column. `grantedById` records who granted it; it is **not** a foreign key to `users` (same as `EventMembership.invitedById`), so it stays as audit data even if the user who granted it is deleted.

Enforced by the use cases, not by the database: a grant cannot be given to the owner's own membership nor to a `REVOKED` membership. Revoking a membership deletes its grant in the same transaction, and re-inviting deletes any leftover grant, so a re-invited member always starts without budget access. Changing a member's role keeps the grant.

### `schedule_items`

Belongs to an `Event` (`onDelete: Cascade`). Tracks timeline entries (`ScheduleItemStatus`: `PENDING` \| `IN_PROGRESS` \| `DONE`), each with an optional location (name, address, coordinates, Mapbox id).

CHECK constraints:
- `schedule_items_rango` — `endsAt`, when set, cannot be earlier than `startsAt`.
- `schedule_items_coords` — same both-or-neither / range rule as `events_venue_coords`, applied to `locationLat`/`locationLng`.

### `schedule_item_vendors`

Assigns a hiring (`EventVendor`) to a timeline item. Belongs to a `ScheduleItem` (`onDelete: Cascade`) and an `EventVendor` (`onDelete: Cascade` — deleting a hiring must not fail with a 500 and its assignments go with it); `assignedById` points to `users` (`onDelete: Restrict`). UNIQUE `(scheduleItemId, eventVendorId)`; indexed by `eventVendorId`. `confirmedAt` is the vendor's confirmation of this assignment: `NULL` means pending, and a new assignment is born pending. Unassigning deletes the row; there is no history.

Enforced by the use cases, not by the database: the `EventVendor` belongs to the same event as the item, is `BOOKED` and has a `vendorProfileId`; and a change to the item's `startsAt` or `endsAt` resets `confirmedAt` to `NULL` on all of its assignments.

### `schedule_item_notes`

A planner-only note on a timeline item. Belongs to a `ScheduleItem` (`onDelete: Cascade`); `authorId` points to `users` (`onDelete: Restrict`). No `updatedAt`: notes are never edited or deleted. Indexed by `(scheduleItemId, createdAt)`.

CHECK constraints:
- `schedule_item_notes_cuerpo` — `body`, trimmed, is 1 to 2000 characters.

Enforced by the use cases, not by the database: only the planner (ADMIN or `PLANNER` member) reads or writes notes.

### `expenses`

Belongs to an `Event` (`onDelete: Cascade`) and optionally to an `EventVendor` (`onDelete: Restrict` — an `EventVendor` with expenses cannot be deleted). Tracks `ExpenseStatus` (`PENDING` \| `PAID`).

CHECK constraints:
- `expenses_monto_positivo` — `amount` must be strictly positive.
- `expenses_origen_exclusivo` — exactly one of `eventVendorId` or `payeeName` must be set (an expense is either billed to a booked vendor or to an external payee, never both, never neither).
- `expenses_pagado_con_fecha` — `status = 'PAID'` if and only if `paidAt` is set.

Invoice columns (all nullable; an expense may have no invoice): `invoiceNumber`, `subtotal` (`Decimal(12,2)`, the amount before taxes; taxes are `amount − subtotal`, derived and not stored), and the file's `invoiceFileKey` (R2 object key), `invoiceFileName`, `invoiceFileType` and `invoiceFileBytes`.

Invoice CHECK constraints:
- `expenses_subtotal_valido` — `subtotal`, when set, is `> 0` and `<= amount`.
- `expenses_archivo_completo` — the four `invoiceFile*` columns are either all set or all null.
- `expenses_numero_no_vacio` — `invoiceNumber`, when set, is not blank (`length(btrim(...)) > 0`).

Invoice UNIQUE index (a partial expression index, written by hand in the migration; `schema.prisma` cannot express it, so it only carries a `///` comment):
- `expenses_invoice_number_unique` — on `(eventId, COALESCE(eventVendorId::text, lower(payeeName)), invoiceNumber) WHERE invoiceNumber IS NOT NULL`. The same invoice number cannot repeat for the same vendor within an event; an external payee is compared case-insensitively (`Ana` = `ANA`). Expenses without a number are unconstrained.

Enforced by the use cases, not by the database: that the invoice file exists in R2, and that `subtotal <= amount` still holds when an update changes only one of the two (the CHECK would reject it, but the use case answers with a domain error first).

### `seating_tables`

Belongs to an `Event` (`onDelete: Cascade`). A round **or rectangular** table of the seating chart (`shape`, enum `SeatingTableShape`: `ROUND` | `RECTANGULAR`, default `ROUND`; it can be changed later and the table keeps its assignments). The shape only changes the drawing: the seat range rules are the same for both. Its seats are the indexes `0..seatCount-1`; there is no row per seat. `x`/`y` are the table's position on the canvas. Tables are listed by `createdAt, id`; the repository writes strictly increasing `createdAt` values so bulk-created tables keep their order.

CHECK constraints:
- `seating_tables_asientos_rango` — `1 ≤ minSeats ≤ seatCount ≤ maxSeats ≤ 20`.
- `seating_tables_posicion` — `x` and `y` cannot be negative.

The limit of 100 tables per event is enforced by the use case, not by the database.

### `seating_objects`

Belongs to an `Event` (`onDelete: Cascade`). A fixture of the room drawn on the seating canvas: no seats, no size, no rotation. `kind` is the enum `SeatingObjectKind` (`DANCE_FLOOR`, `STAGE`, `BAR`, `DESSERT_TABLE`, `ENTRANCE`) and is fixed after creation; `label` is free text; `x`/`y` are the position on the canvas. Objects are listed by `createdAt, id`; the repository writes strictly increasing `createdAt` values.

CHECK constraints:
- `seating_objects_posicion` — `x` and `y` cannot be negative.
- `seating_objects_etiqueta` — `label` has between 1 and 60 characters.

The limit of 30 objects per event is enforced by the use case, not by the database.

### `seat_assignments`

Who sits in a seat: the guest (`companionIndex = 0`) or one of their companions (`1..10`). Belongs to an `Event`, a `SeatingTable` and a `Guest`, all with `onDelete: Cascade` — deleting a table or a guest frees its seats. Unique on `(tableId, seatIndex)` (one person per seat) and on `(guestId, companionIndex)` (one seat per person).

CHECK constraints:
- `seat_assignments_indices` — `seatIndex ≥ 0` and `companionIndex` between `0` and `10`.

That `seatIndex < seatCount` of its table, and that the person fits the guest's current RSVP, cross tables and are enforced by the use cases, which lock the event row (`SELECT … FOR UPDATE`) inside a transaction before validating. A seat whose occupant no longer fits (the guest declined or lowered their companions) is kept and reported as `sobrante`.

### `conversations`

A messaging conversation. `kind` is `ConversationKind` (`EVENT_DIRECT` | `EVENT_ROOM` | `PROFILE`): `EVENT_DIRECT` is 1:1 inside an event, `EVENT_ROOM` is the event's group room (couple and planners, never vendors), `PROFILE` is a vendor-profile contact request (part 3). `eventId` is nullable (`onDelete: Cascade`: deleting the event deletes its conversations, participants and messages). `pairKey` is `unique` and holds `eventId:smaller:larger` (the two user ids ordered), so there is at most one direct conversation per event and pair, whoever opens it; it is null for kinds without a pair (nulls do not collide). `lastMessageAt` is null until the first message.

A `PROFILE` conversation has no event: `requesterId` (FK `users`, `onDelete: Cascade`), `vendorProfileId` (FK `vendor_profiles`, `onDelete: Cascade`), `requestStatus` (`ContactRequestStatus`: `PENDING` | `ACCEPTED` | `DECLINED`) and `declinedAt`. Its `pairKey` is `profile:<smaller>:<larger>` (the two user ids), so there is one per pair. These four columns are null in every other kind.

An `EVENT_ROOM` has `pairKey = 'room:<eventId>'`, so the same `unique` allows one room per event; it is created lazily the first time someone opens or lists it.

CHECK constraints:
- `conversations_sala_clave` — an `EVENT_ROOM` has `eventId` and its `pairKey` is `'room:' || eventId`.
- `conversations_perfil_campos` — `kind = 'PROFILE'` if and only if `eventId` is null and `requesterId`, `vendorProfileId` and `requestStatus` are all set.
- `conversations_perfil_rechazo` — `declinedAt` is set if and only if `requestStatus = 'DECLINED'` (a null status counts as not declined).
- `conversations_perfil_clave` — a `PROFILE` has a non-null `pairKey` starting with `profile:` (a null key would dodge the `unique`).
- `conversations_perfil_solo_en_perfil` — a non-`PROFILE` conversation has `requesterId`, `vendorProfileId`, `requestStatus` and `declinedAt` all null (`conversations_perfil_campos` alone lets an `EVENT_DIRECT` with `eventId` set carry them).

Enforced by the use cases, not by the database: that a direct conversation has `eventId` and `pairKey`, that its two participants are allowed together (member↔member and member↔vendor, never vendor↔vendor) and that both have access to the event when it is opened. For `PROFILE` conversations: `requestStatus` only moves `PENDING` → `ACCEPTED` \| `DECLINED`, and `DECLINED` → `PENDING` \| `ACCEPTED` when the original requester asks again; a new request after a decline waits 24 h from `declinedAt` (unless requester and vendor are already related, in which case it is accepted at once); the requester cannot be the owner of the vendor profile; `requesterId` and `vendorProfileId` never change after creation.

### `conversation_participants`

Primary key `(conversationId, userId)`, both `onDelete: Cascade`. Holds the two per-participant marks, "delivered up to" (`deliveredUpToAt`/`deliveredUpToId`) and "read up to" (`readUpToAt`/`readUpToId`): the `createdAt` and `id` of a message of that conversation. Messages are ordered by `(createdAt, id)`.

CHECK constraints:
- `conversation_participants_leido_par` — `readUpToAt` and `readUpToId` are both set or both null.
- `conversation_participants_recibido_par` — `deliveredUpToAt` and `deliveredUpToId` are both set or both null.

Enforced by the use cases, not by the database: marks only move forward (never backwards) and each `...Id` points at a message of that conversation (it is not a foreign key).

### `messages`

Belongs to a `Conversation` (`onDelete: Cascade`) and to its sender, a `User` (`onDelete: Restrict` — a user with messages cannot be deleted). Indexed by `(conversationId, createdAt, id)` for backwards cursor pagination.

CHECK constraints:
- `messages_cuerpo_longitud` — `char_length(btrim(body))` is between 1 and 2000.

That the sender is a participant of the conversation and still has access to the event is enforced by the use cases.

### `message_recipients`

Recipients of a message in an event room, fixed when the message is sent: the event's ACTIVE members at that instant, without the sender. Primary key `(messageId, userId)`, both `onDelete: Cascade`; indexed by `(userId, messageId)`. Direct conversations do not use it.

It is the only record of who was in the room when (memberships keep no history: re-inviting reuses the row). It fixes the M of "read by N of M", how far a member who left can still read (their last message as sender or recipient) and the unread count of someone who joined late (only messages they are a recipient of).

Enforced by the use cases, not by the database: that the recipients are exactly the ACTIVE members at send time and never the sender or a vendor.

### `moodboard_images`

A photo on an event's inspiration board. Belongs to an `Event` (`onDelete: Cascade`) and to a `VendorCategory` (`onDelete: Restrict` — a category with photos cannot be deleted). `uploadedById` and `archivedById` point to `users` (`onDelete: Restrict`). `storageKey` is unique and holds the object key in R2, never a URL. `width`/`height` are measured by the client before uploading and only reserve the masonry box: they are not a security boundary. Nothing is deleted through the API: a photo is archived (`archivedAt` + `archivedById`). Indexed by `(eventId, createdAt)`.

CHECK constraints:
- `moodboard_images_titulo` — `title`, trimmed, is 1 to 120 characters.
- `moodboard_images_dimensiones` — `width` and `height` are each between 1 and 20000.
- `moodboard_images_archivado_coherente` — `archivedAt` and `archivedById` are both null or both set.

Enforced by the use cases, not by the database: the cap of **500 photos per event** (active + archived, since nothing is deleted), checked inside the transaction after locking the event row with `SELECT … FOR UPDATE`, like the tables cap; and that `categoryId` is an active category.

### `moodboard_shares`

Shares a photo with one hiring (`EventVendor`). Belongs to a `MoodboardImage` (`onDelete: Cascade`) and an `EventVendor` (`onDelete: Cascade` — a share belongs to the hiring, so removing the hiring removes its shares; notes hang off the photo, not the share, and survive); `sharedById` points to `users` (`onDelete: Restrict`). UNIQUE `(imageId, eventVendorId)`: sharing again revives the row (`revokedAt = null`) instead of duplicating it, and unsharing sets `revokedAt`, so the history is kept. Indexed by `eventVendorId`.

Enforced by the use cases, not by the database: the `EventVendor` belongs to the same event as the image, is `BOOKED` and has a `vendorProfileId`; and a vendor hired twice in the same event sees the photos shared with either hiring.

### `moodboard_notes`

A note on a photo. Belongs to a `MoodboardImage` (`onDelete: Cascade`); `authorId` points to `users` (`onDelete: Restrict`). No `updatedAt`: notes are never edited or deleted. Indexed by `(imageId, createdAt)`.

CHECK constraints:
- `moodboard_notes_cuerpo` — `body`, trimmed, is 1 to 2000 characters (same cap as chat messages).

## Development Workflow

### Creating a New Migration

```bash
# Edit schema.prisma
nano prisma/schema.prisma

# Create and apply migration
npm run db:migrate:dev
# Follow prompts to name the migration (e.g., "add_user_field")
```

This creates a new migration file in `prisma/migrations/` and applies it immediately.

### Quick Schema Sync (Prototyping)

```bash
# For rapid prototyping without creating migration history:
npm run db:push
```

⚠️ **Don't use in production** — use `db:migrate:dev` in shared envs.

### Inspect Data

```bash
# Open Prisma Studio (web UI)
npm run db:studio
# Runs on http://localhost:5555
```

### Reset Local Database

```bash
# Wipe database and reapply all migrations
npm run db:migrate:reset
```

## Docker Workflow

### First Time Setup

```bash
# Start services (postgres, redis)
docker-compose up -d

# Apply migrations inside container
npm run db:docker:migrate
```

### Restart Fresh

```bash
# Stop and remove volumes, restart
npm run db:docker:reset

# Reapply migrations
npm run db:docker:migrate
```

### Run Command in Container

```bash
docker-compose run --rm backend npx prisma <command>
```

## Production Deployment

```bash
# Deploy pending migrations
npm run db:migrate:deploy

# On failure, check migration status:
npm run db:migrate:deploy -- --help
```

## Seed Data

Edit `scripts/seed.ts` to add test data:

```typescript
const user = await prisma.user.create({
  data: {
    email: 'dev@example.com',
    passwordHash: '...',
    fullName: 'Dev User',
  },
});
```

Then run:

```bash
npm run db:seed
```

## Troubleshooting

### Migration Conflicts

If migrations conflict in git:

```bash
# Resolve conflicts in .sql files
git merge --continue

# Verify consistency
npm run db:migrate:deploy -- --status
```

### Lost Migrations

If database state is inconsistent:

```bash
# Check current migration status
npm run db:migrate:deploy -- --status

# Mark migration as applied/rolled back
npm run db:migrate:deploy -- --resolve <name>
```

### Database Won't Connect (Docker)

The connection string uses the service name `postgres`:
```
DATABASE_URL=postgresql://wp:wp@postgres:5432/wedding_planner
```

This only works inside containers. For local development, use `localhost`:
```
DATABASE_URL=postgresql://wp:wp@localhost:5432/wedding_planner
```
