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

### `schedule_items`

Belongs to an `Event` (`onDelete: Cascade`). Tracks timeline entries (`ScheduleItemStatus`: `PENDING` \| `IN_PROGRESS` \| `DONE`), each with an optional location (name, address, coordinates, Mapbox id).

CHECK constraints:
- `schedule_items_rango` — `endsAt`, when set, cannot be earlier than `startsAt`.
- `schedule_items_coords` — same both-or-neither / range rule as `events_venue_coords`, applied to `locationLat`/`locationLng`.

### `expenses`

Belongs to an `Event` (`onDelete: Cascade`) and optionally to an `EventVendor` (`onDelete: Restrict` — an `EventVendor` with expenses cannot be deleted). Tracks `ExpenseStatus` (`PENDING` \| `PAID`).

CHECK constraints:
- `expenses_monto_positivo` — `amount` must be strictly positive.
- `expenses_origen_exclusivo` — exactly one of `eventVendorId` or `payeeName` must be set (an expense is either billed to a booked vendor or to an external payee, never both, never neither).
- `expenses_pagado_con_fecha` — `status = 'PAID'` if and only if `paidAt` is set.

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
