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
executes the full test suite. **Expect ~2-6 minutes locally**, ~2-3 min on GitHub
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
  table runs inside `withTenant`. Pass `{ write: true }` on paths that
INSERT or UPDATE a `sync_seq`-producing table.
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

1. Write the test that reproduces the bug, and wrap it in Vitest's
   `it.fails`. The test asserts the correct behaviour; `it.fails`
   makes the suite pass as long as the bug is present.

       it.fails('pull returns site A after reassignment', async () => {
         // ... the assertion that currently fails
       });

2. Commit the `it.fails` test alone as
   `test(scope): prove <bug> (red)`. The suite is green because the
   assertion is expected to fail.

3. Fix the bug, flip `it.fails` to `it` in the same commit as the
   fix: `fix(scope): <what>`. The suite is green for the right reason.

4. Push both commits in one PR. The history proves the fix works, and
   no commit in the branch was ever red.

If you cannot use `it.fails` (the test also asserts that the setup is
sound), add a guard test in `it` that proves the scenario is correct,
and keep the bug-reproducing test in `it.fails`.

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

    import { withTenant } from './with-tenant.js';

    return withTenant(this.db, tenantId, async (tx) => {
      // ... the writes
    }, { write: true });

`{ write: true }` takes the per-tenant advisory lock before any
INSERT/UPDATE. It serialises every sync_seq-producing write of the
tenant until commit, so two transactions cannot commit out of order and
leave a gap in the visible sequence. Omit it on read paths.

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
   wrap with `withTenant`. Pass `{ write: true }` if the callback
   issues any INSERT or UPDATE that fires the `sync_seq` trigger.
4. Add tests in the matching `*.http.spec.ts` file. Use `Test.createTestingModule`
   with `controllers: [YourController]` and explicit providers — see
   `test/sync.http.spec.ts` for the pattern.
5. Run `npx tsc --noEmit && npx vitest run`.

### 5.3 Add a test

Tests are in `test/*.spec.ts`. The convention is one `describe` per
file, and one `it` per scenario, named in plain English.

If your test needs a database, extend `TestPostgres` (see
`test/helpers/testcontainers-pg.ts`). It boots a real PostgreSQL 16,
applies migrations 001 through 013 in order, and exposes:

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

- `JWT_SECRET` — only used in **dev-secret mode** (`JWKS_URL` empty).
  Boot guards reject values shorter than 32 chars or equal to the
  `.env.example` placeholder. In production the app runs in **JWKS mode**
  and never uses this secret; tokens are signed by the provider. Rotating
  in production means rotating the provider's signing keys, which is
  transparent to this service (the JWKS endpoint is polled and cached).
- `S3_SECRET_ACCESS_KEY` — set in the deployment environment. Rotation
  is transparent to the app (the SDK reads it at boot).

---

## 6. Auth strategies

The app runs in one of two modes, chosen at boot by `readIdpConfig`:

| Env | Mode | Signing |
|---|---|---|
| `JWKS_URL` set | `jwks` | Provider signs; app verifies via JWKS |
| `JWKS_URL` empty, non-prod | `dev-secret` | App signs with `JWT_SECRET` |

Production **requires** `JWKS_URL` and `JWT_AUDIENCE`. The boot guard
refuses to start otherwise. `/auth/token` is disabled in production
regardless, gated by `AUTH_ALLOW_DEV_TOKEN`.

To use a provider whose tenant is not in a plain `tenantId` claim, set
`JWT_TENANT_CLAIM` to the claim name (a URI, typically). The guard reads
the claim by that exact name.

## 7. Privileged operations on append-only tables

Some tables are append-only for `sync_app` on purpose: `sync_logs`
(migration 014) revokes every privilege except `SELECT` and `INSERT`.
A retention job still has to `DELETE` from them. The pattern is a
`SECURITY DEFINER` function that runs the `DELETE` with the migration
role's privileges, called by `sync_app` through `EXECUTE`.

The template (see `migrations/015_purge_sync_logs.sql` for the full
version):

    CREATE OR REPLACE FUNCTION <name>(...)
    RETURNS JSONB
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
    AS $
    BEGIN
      -- guards first: retention floor, tenant check, anything else
      -- that must hold before a privileged DELETE runs
      ...
      DELETE FROM <table> WHERE ...;
      RETURN jsonb_build_object(...);
    END;
    $;

    REVOKE ALL ON FUNCTION <name>(...) FROM PUBLIC, sync_app;
    GRANT EXECUTE ON FUNCTION <name>(...) TO sync_app;

Three rules:

1. **`SET search_path = pg_catalog, public, pg_temp`** is mandatory.
   Without `pg_catalog` first, a hostile schema earlier in the search
   path could shadow `current_setting` or any other built-in the
   function calls.
2. **`REVOKE ALL ... FROM PUBLIC, sync_app` before the GRANT.** The
   default grant on a new function is EXECUTE to PUBLIC. Without the
   REVOKE, any role can call it.
3. **Guard inside the function, not only at the call site.** A
   SECURITY DEFINER function bypasses the caller's privileges; the
   floor, the tenant check, and any other invariant must live in the
   function body.

Test the function like any other privileged path:
`has_function_privilege`, `pg_proc.prosecdef`, `proconfig`,
cross-tenant refusal, floor refusal, and a direct `DELETE` from
`sync_app` that must fail. See `test/sync-logs-purge.spec.ts` for the
10-test template.

## 8. Git conventions

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

## 9. Troubleshooting

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

## 9. Where to ask

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

## 10. Checklist before opening a PR

- [ ] `npx tsc --noEmit` is silent.
- [ ] `npx vitest run` reports no failure, no skip, no `it.only` left
      in the diff. The exact count is not the criterion.
- [ ] No `console.log` left in committed code.
- [ ] Every new tenant-scoped query uses `withTenant`, with
      `{ write: true }` for any path that INSERTs or UPDATEs a
      `sync_seq`-producing table.
- [ ] Every schema change has a matching migration.
- [ ] The commit messages follow the convention in §7.
- [ ] The branch is rebased on `main`.
- [ ] The CI is green.

A PR that doesn't tick all these boxes will be asked to fix them before
review.

## Production: enabling the application role

Migration 011 declares the `sync_app` role but migration 012 sets it to
`NOLOGIN`. The repository never ships a usable password. On a real
environment, the operator grants LOGIN once, after the migrations have
run, with a generated password:

    -- as the database owner:
    ALTER ROLE sync_app LOGIN PASSWORD '<generated-strong-password>';

Store that password in the deployment's secret manager. Do not put it in
`.env.example`, do not put it in a migration, do not put it in the repo.
The application reads it from `SYNC_APP_PASSWORD` (or whatever your
deployment uses) at boot.

If the password is ever rotated, the same ALTER ROLE is enough — no code
change, no migration.
