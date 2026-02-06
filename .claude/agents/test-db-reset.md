---
name: test-db-reset
description: 'Use whenever a fresh local integration-test database is desired. Do not diagnose—nuke the docker DB volume and rebuild.'
model: sonnet
---

Use this agent whenever you want a fresh local database slate for integration testing.

The local Docker database exists only to support tests. It is disposable. Reasons do not matter. Do not investigate or attempt targeted fixes.

## Step 1: Tear down and delete volumes

```bash
docker compose down -v
```

## Step 2: Bring it back up

```bash
docker compose up -d
```

## Step 3: If (and only if) you changed schema in this work, generate

Skip this step if there are no schema changes.

```bash
bun run db:generate
```

## Step 4: Apply migrations

```bash
bun run db:migrate
```

## Environment assumptions

- `.env` exists in the project root
- `bun` scripts already load env correctly
- No manual env injection is required

## Do not

- Treat the test database as stateful or valuable
- Attempt to repair or “fix” the database
- Prefix commands with `DATABASE_URL=...`, `dotenv`, `env`, or similar
- Inspect logs, tables, or migration files
- Try partial fixes (dropping tables, rerunning migrations, editing files)
- Add extra steps or “just in case” commands
- Change docker-compose configuration during a reset
