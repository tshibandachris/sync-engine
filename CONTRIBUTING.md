# Contributing — Development Guide

This is the day-to-day guide for working on the sync-engine. It assumes
you have read `HANDOFF.md` (what the project is, its architecture, its
roadmap). This document tells you **how** to work on it.

For a first-time setup, read §1. For daily work, jump to §3. For
common tasks (add a migration, add an endpoint), see §5.

---

## 1. First-time setup

### Prerequisites

- **Node.js 20+** (`node --version`). Tested on v24.
- **Docker Desktop** running. Testcontainers spawns a PostgreSQL 16
  container per test file. On Windows, keep Docker Desktop open and
  wait for the whale icon to be green.
- **Git** with a GitHub account that can push to
  `github.com/tshibandachris/sync-engine`.

### Clone and run

    git clone https://github.com/tshibandachris/sync-engine.git
    cd sync-engine
    npm install
    npm run typecheck
    npx vitest run

The first `vitest run` pulls `postgres:16-alpine` (~60s) and then
executes 85 tests. **Expect ~2-6 minutes locally**, ~25s on GitHub
Actions.

### Verify you can reproduce the CI

The GitHub Actions workflow runs the same commands on `ubuntu-latest`.
If your local run passes, the CI should too. If they diverge, Docker or
your local Node version is the culprit.

---

## 2. Architecture in 30 seconds

Read these four files in this order before writing any code:

1. `migrations/001_sync_infra.sql` — the base schema.
2. `src/schema.ts` — Drizzle's view of the schema.
3. `src/sync-push.service.ts` — where conflicts are detected and
   resolved. The trickiest file in the project.
4. `test/sync.integration.spec.ts` — what the tests actually assert.

For deeper context, `HANDOFF.md` has the full picture (protocol, RLS,
attachments, roadmap).

**Key invariants to respect:**

- **Global sequence.** All three synchronized tables (`sites`,
  `missions`, `check_ins`) share one `global_sync_seq`. Never use a
  per-table sequence.
- **Timestamps in ms (BIGINT).** Never `TIMESTAMPTZ` for `sync_seq`-related
  fields. The WatermelonDB client on the other end expects numbers.
- **Tenant context.** Every query that touches a `tenant_id`-bearing
  table runs inside `withTenant` (read) or `lockTenantWrites` (write).
  No exceptions.
- **No schema change without a migration.** `src/schema.ts` and
  `migrations/*.sql` must stay in sync. See §5.1.

---

## 3. Daily workflow

### Branching

- `main` is protected by convention. Never push directly.
- One branch per feature or fix: `feat/attachments-thumbnails`,
  `fix/cursor-gap-test`, `chore/upgrade-drizzle`.
- Rebase on `main` before opening a PR. Do not merge `main` into your
  branch.

### Test-first

For any bug fix:

1. Write a failing test that reproduces the bug. Commit it as
   `test(scope): failing test for <bug>`.
2. Fix the bug. Commit as `fix(scope): <what>`.
3. The two commits in one PR prove the fix works.

For any feature, write the test at the same time as the code. See §5.3.

### Before every commit

    npx tsc --noEmit
    npx vitest run

Both must pass. If they don't, don't commit. If you're mid-work and want
a checkpoint, use `git stash` — don't commit a red state to a branch
that will be pushed.

### Before every push

    git pull --rebase origin main
    npx vitest run
    git push

The CI will run again on push. It takes ~30s. Watch the badge on GitHub
(`github.com/tshibandachris/sync-engine/actions`). A red CI is never
acceptable on a PR.

---

## 4. Code conventions

### Naming

- Files: `kebab-case.ts`. Services: `sync-*.service.ts`. Controllers:
  `sync-*.controller.ts`.
- Types: `PascalCase`. Interfaces ending in `Dto` for request shapes.
- Booleans: `hasMore`, `isDeleted`, not `more`, `deleted`.

### Services

Each service takes the Drizzle database in its constructor. No NestJS
decorators inside services except `@Injectable()` on the class. The
module wires them.

    export class MyService {
      constructor(private readonly db: NodePgDatabase<typeof schema>) {}
    }

### Transactions

For a write that touches a `sync_seq`-bearing table:

    import { lockTenantWrites } from './tenant-write-lock.js';

    await this.db.transaction(async (tx) => {
      await lockTenantWrites(tx, tenantId);
      // ... rest of the writes
    });

For a read that touches a `tenant_id`-bearing table:

    import { withTenant } from './with-tenant.js';

    return withTenant(this.db, tenantId, async (tx) => {
      // ... queries use `tx`, not `this.db`
    });

**Never** call `this.db.select()` or `this.db.execute()` directly on a
tenant-scoped table. The RLS policies will return zero rows for a
non-superuser role, and the test suite won't catch it (it runs as
`postgres`, which bypasses RLS). Use the wrappers.

### Errors

Prefer NestJS exceptions (`BadRequestException`, `ForbiddenException`,
`NotFoundException`, `ConflictException`, `GoneException`). They map
cleanly to HTTP codes.

### Logging

No `console.log` in committed code. If you need to debug, use
`console.error` temporarily and remove before the commit.

---

## 5. Common recipes

### 5.1 Add a column to an existing table

1. Write a new migration `migrations/0XX_<name>.sql`. **Never modify
   an existing migration** — production may already have applied it.
2. Update `src/schema.ts` to declare the column.
3. Update the test helper if needed (`test/helpers/testcontainers-pg.ts`
   reads migrations from disk in order; a new file is picked up
   automatically if named correctly).
4. Run `npx vitest run`. If a test fails because a seed doesn't provide
   the new column, patch the seed.

**Watch out for BOM.** PowerShell's `Set-Content -Encoding UTF8` adds a
byte-order mark on PS 5.x. PostgreSQL rejects it with
`syntax error at or near "CREATE"`. Always write `.sql` and `.ts` files
via VS Code, or via a Node script using
`fs.writeFileSync(path, Buffer.from(content, 'utf8'))`.

### 5.2 Add a new HTTP endpoint

1. Add the route in the relevant controller
   (`src/sync.controller.ts`, `src/sync-attachment.controller.ts`).
2. Declare the request shape as an interface (`interface FooBody { ... }`).
   Validate with explicit `if` checks — the project doesn't use
   `class-validator` pipes.
3. Add a service method. If the endpoint reads or writes tenant data,
   wrap with `withTenant` or `lockTenantWrites`.
4. Add tests in the matching `*.http.spec.ts` file. Use `Test.createTestingModule`
   with `controllers: [YourController]` and explicit providers — see
   `test/sync.http.spec.ts` for the pattern.
5. Run `npx tsc --noEmit && npx vitest run`.

### 5.3 Add a test

Tests are in `test/*.spec.ts`. The convention is one `describe` per
file, and one `it` per scenario, named in plain English.

If your test needs a database, extend `TestPostgres` (see
`test/helpers/testcontainers-pg.ts`). It boots a real PostgreSQL 16,
applies migrations 001 through 011 in order, and exposes:

- `pg.pool` — superuser pool (bypasses RLS, used for seeds).
- `pg.db` — Drizzle on `pg.pool`.
- `pg.appPool` / `pg.appDb` — connected as `sync_app`, subject to RLS.

Use `pg.pool` for seeds and setup, `pg.appPool` when you want to prove
RLS behavior.

### 5.4 Rename a service or file

Grep for the old name across `src/`, `test/`, and `HANDOFF.md`. Update
imports, DI tokens in `app.module.ts`, and any reference in docs. The
`npx tsc --noEmit` will catch type errors, but string-based DI tokens
(`'DRIZZLE_DB'`, `'ATTACHMENT_STORAGE'`) are not typed.

### 5.5 Rotate a secret

- `JWT_SECRET` — set in the deployment environment. Boot guards reject
  values shorter than 32 chars or equal to the `.env.example` placeholder.
  Rotating means invalidating all live tokens. Do it during a maintenance
  window.
- `S3_SECRET_ACCESS_KEY` — set in the deployment environment. Rotation
  is transparent to the app (the SDK reads it at boot).

---

## 6. Git conventions

### Commit messages

    <type>(<scope>): <what>

Allowed types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`.

Examples:

- `feat(sync): add 410 GONE for stale pull cursors`
- `fix(rls): restore migration order in test helper`
- `test(sync): add failing regression for cursor gaps`
- `chore: remove one-shot patch scripts`

One logical change per commit. If a commit message needs "and", split it.

### Tags

Tags mark shipped versions. Format: `v<major>.<minor>[.<patch>][a|b|c]-sync-engine`.
Examples: `v0.5-sync-engine`, `v0.5.4c-sync-engine`.

**Only tag after green tests locally AND a green CI run.** A tag is
immutable once pushed. If you need to correct a tagged commit, create a
new patch tag; do not force-push over the old one.

The list of tags is the release history. See `HANDOFF.md` for the
mapping.

---

## 7. Troubleshooting

### "Could not find a working container runtime strategy"

Docker isn't running. Start Docker Desktop, wait for the green whale,
then `docker ps` should return an empty table header. Retry.

### "column X does not exist" in a test

You changed `src/schema.ts` without adding a migration, or vice versa.
The test helper applies migrations in order, not the Drizzle schema.
Add the migration, run again.

### "syntax error at or near 'CREATE'" in a migration

BOM issue. Rewrite the file with a Node script:

    const fs = require('fs');
    fs.writeFileSync(path, Buffer.from(content, 'utf8'));

or save via VS Code with encoding UTF-8 (no BOM).

### "Tests time out" or the run hangs

Docker is slow or a container is stuck. `docker ps` should show no
lingering `postgres:16-alpine` containers between runs. If you see some,
`docker rm -f <id>`.

### "the test passes locally but fails in CI"

The reverse (fails locally, passes CI) is more common — Docker not
running locally. The forward case usually means:

- A hardcoded Windows path in a test (use `path.join`).
- A test that depends on `os.tmpdir()` or `os.EOL`.
- Timing-sensitive test — increase `testTimeout` in `vitest.config.ts`.

### Vitest reports "minThreads and maxThreads must not conflict"

You upgraded Vitest. The `vitest.config.ts` uses `fileParallelism: false`
which is Vitest 2 syntax. On Vitest 4+, rewrite the pool options.

---

## 8. Where to ask

- **Architecture or protocol questions**: read `HANDOFF.md` first, then
  the source file named in the roadmap.
- **Drizzle-specific issues**: the Drizzle docs are good; search for
  the exact function name (`onConflictDoUpdate`, `with`, etc.).
- **NestJS-specific issues**: the NestJS docs cover the DI / module
  patterns used here.
- **Testcontainers-specific issues**: the Testcontainers docs have a
  Node.js section; verify your Docker install is up to date.

If you're stuck for more than 30 minutes on a technical issue, stop and
ask. Two brains on a stuck problem beats one brain frustrated.

---

## 9. Checklist before opening a PR

- [ ] `npx tsc --noEmit` is silent.
- [ ] `npx vitest run` shows `85 passed` (or more).
- [ ] No `console.log` left in committed code.
- [ ] Every new tenant-scoped query uses `withTenant` or `lockTenantWrites`.
- [ ] Every schema change has a matching migration.
- [ ] The commit messages follow the convention in §6.
- [ ] The branch is rebased on `main`.
- [ ] The CI is green.

A PR that doesn't tick all these boxes will be asked to fix them before
review.