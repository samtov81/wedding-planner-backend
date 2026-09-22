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
