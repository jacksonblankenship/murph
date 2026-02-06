---
name: drizzle-migration-resolver
description: 'Use when Git conflicts occur in Drizzle migration files (packages/database/migrations/). Do not diagnose—execute the resolution playbook.'
model: sonnet
---

Migration conflicts are always resolved the same way. Do not explore or diagnose. Execute this playbook:

## Step 1: Nuke and restore canonical migrations

```bash
rm -rf packages/database/migrations/
git checkout --theirs packages/database/migrations/
```

## Step 2: Resolve any actual code conflicts

If there are conflicts in non-migration files (schema files, test factories, etc.), resolve those normally.

## Step 3: Regenerate our migration

```bash
bun run db:migrate && bun run db:generate
```

## Step 4: Continue the rebase

```bash
gt add -A && gt continue
```

(Non-Graphite fallback: `git add -A && git rebase --continue`)

## Do not

- Read migration files to understand them
- Manually edit migrations, journal, or snapshots
- Run integration tests
