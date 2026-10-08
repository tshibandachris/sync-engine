![CI](https://github.com/tshibandachris/sync-engine/actions/workflows/ci.yml/badge.svg)

# Sync Engine — Handoff

## What it is

Multi-tenant synchronisation engine for a field-agent mobile app.
Mobile stack: **React Native + WatermelonDB** (to be confirmed — see Open questions).

- Incremental pull/push of `check_ins`, `missions`, `sites`
- Conflict detection + resolution (LWW on `sync_seq`)
- Idempotent push (advisory locks + idempotency keys)
- JWT auth with tenant scoping
- S3 presigned uploads for incident photos

**Current state: tag `v0.5-sync-engine`, 58 tests green.**

## Stack

- Node.js 20+ (tested on v24)
- TypeScript (ESM, `type: module`)
- NestJS 10.4 for HTTP
- Drizzle ORM + PostgreSQL 16
- Vitest 2
- Testcontainers (real PostgreSQL per test file)
- AWS SDK v3 (S3)

## Quick start

    git clone https://github.com/tshibandachris/sync-engine.git
    cd sync-engine
    npm install
    npm run typecheck
    npx vitest run

Requirements: Docker running. The first run pulls `postgres:16-alpine`
(~60s). Subsequent test runs take ~120s end to end (5 test files, each
spins its own container).

### Running the app locally

    cp .env.example .env
    # edit .env with your DATABASE_URL, JWT_SECRET, S3_* values
    npm run dev

`npm run dev` is not defined yet — see Debt / "no dev script".
In the meantime, `npx tsx src/main.ts` works.

`.env.example`:

    DATABASE_URL=postgres://postgres:postgres@localhost:5432/sync
    JWT_SECRET=change-me-at-least-32-characters-long
    PORT=3000
    AUTH_ALLOW_DEV_TOKEN=true
    S3_BUCKET=sync-attachments-dev
    S3_REGION=us-east-1
    S3_ENDPOINT=http://localhost:9000
    S3_ACCESS_KEY_ID=minio
    S3_SECRET_ACCESS_KEY=minio123

## Architecture

### Sync protocol

Four routes:

| Route | Purpose |
|---|---|
| POST /sync/pull | Get changes since cursor |
| POST /sync/push | Send local changes (versioned, idempotent) |
| GET /sync/conflicts | List pending conflicts |
| POST /sync/conflicts/:id/resolve | Resolve (client/server/dismiss) |

**Cursor.** One global sequence (`global_sync_seq`) shared across
`sites`, `missions`, `check_ins`. Pull returns rows with
`sync_seq > cursor`, ordered ascending, plus `has_more: boolean`.
Default page size 500, max 1000.

**Conflict model.** Each row has a `sync_seq`. When a client updates
a row, it sends `version`, which is the `sync_seq` value the client
last saw for that row. If `version != server row's current sync_seq`,
the write is recorded in `sync_conflicts` instead of applied. LWW
for now — see Open questions for merge-by-field considerations.

**Write serialisation (tenant-level lock).**

Every code path that writes to a `sync_seq`-bearing table takes a
tenant-level advisory lock for the whole transaction:

    SELECT pg_advisory_xact_lock(7301, hashtext('<tenant_id>'))

- Constant namespace `7301` — disjoint from the idempotency locks and
  from the test gate key in `test/cursor-gaps.spec.ts` (424242).
- Helper: `withTenant(db, tenantId, fn, { write?: boolean })`. Reads omit
  `write`; writes pass `{ write: true }` and take the tenant advisory
  lock.
- Must be the **first statement** of the transaction, before the
  per-(agent, key) idempotency lock and before any INSERT/UPDATE that
  fires the `sync_seq` trigger.
- Paths that take it: `SyncPushService.pushChanges`,
  `SyncConflictService.resolveConflict` (only when resolution is
  `client`, which writes to `check_ins`).
- Path that does **not** take it: `SyncMaintenanceService.purge` — it
  only touches `sync_conflicts` and `sync_idempotency_keys`, neither
  of which carries a `sync_seq` column.

**Why:** `nextval('global_sync_seq')` is not transactional. Without a
lock, a transaction that obtains seq N can commit after one that
obtained seq N+1, leaving a gap. A client pulling between the two
commits advances past the gap and never sees the earlier row.

**Cost:** all pushes of a single tenant are serialised. At 10k agents
on the same tenant, a peak at shift start becomes a queue. Documented
trade-off for correctness. The alternative is a transactional outbox
fed by a non-cached sequence — a larger refactor, deliberately
deferred.

### Row-Level Security

`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on all 7
tenant-scoped tables (`sites`, `missions`, `check_ins`,
`sync_conflicts`, `sync_idempotency_keys`, `attachments`,
`sync_purge_state`). Policies are `FOR ALL` with `USING` + `WITH CHECK`,
keyed on `current_setting('app.current_tenant_id', true)`.

**Fail-closed:** missing `app.current_tenant_id` yields zero rows, not all
rows. `NULLIF(current_setting(...), '')::uuid` turns both the absent
setting and the empty string into `NULL`, and `tenant_id = NULL` is
filtered out by SQL semantics.

**App role.** The app connects as `sync_app`, a non-superuser,
non-owner role created in migration 011. `postgres` (superuser) bypasses
RLS by PostgreSQL rule and is used only by the test setup to seed data.

**Context injection.** Two wrappers in `src/`:

- `withTenant(db, tenantId, fn)` - read paths. Opens a transaction,
  calls `set_config('app.current_tenant_id', $1, true)`, runs `fn`.
- `withTenant(db, tenantId, fn, { write: true })` - write paths. Same `set_config`,
  plus the tenant-level advisory lock.

**Paths that use them:**

| Service | Method | Wrapper |
|---|---|---|
| SyncPullService | pullChanges | withTenant |
| SyncConflictService | listConflicts | withTenant |
| SyncAttachmentService | listForCheckIn | withTenant |
| SyncMaintenanceService | purgeTenantTombstones | withTenant |
| SyncPushService | pushChanges | withTenant({ write: true }) |
| SyncConflictService | resolveConflict | withTenant({ write: true }) |

**Proof.** `test/rls-isolation.spec.ts` runs 6 tests through the
`sync_app` pool:

- Without `set_config`, SELECT returns zero rows (fail-closed).
- With `set_config` for tenant A, SELECT returns only A's rows, even
  with an explicit `WHERE id = <tenant B row>`.
- An INSERT with a mismatched `tenant_id` is rejected by the
  `WITH CHECK` clause.
- `withTenant` makes both A and B see only their own data.

### Attachments

| Route | Purpose |
|---|---|
| POST /attachments/request-upload | Creates pending row + presigned PUT URL (15 min) |
| POST /attachments/:id/confirm | HEAD-checks S3, marks uploaded |
| GET /attachments?check_in_id=... | Lists uploaded + presigned GET URLs (1h) |

S3 is never proxied. The client uploads directly.

**Limits:** 5 attachments per check-in, 10 MB each, content types
`image/jpeg`, `image/png`, `image/heic`. `checksum_sha256` must be
64 hex characters.

**S3 key format:** `tenants/<tenant_id>/checkins/<check_in_id>/<attachment_id>.<ext>`.
This allows per-tenant lifecycle rules and bulk deletion later.

**Known limitation:** presigned PUT does not enforce size or type on
the S3 side. `confirm` does a HEAD but currently only checks
existence. See Roadmap v0.5.5.

### Multi-tenancy

`tenant_id` column on 6 tables: `sites`, `missions`, `check_ins`,
`sync_conflicts`, `sync_idempotency_keys`, `attachments`.

Composite FKs: `(site_id, tenant_id)`, `(mission_id, tenant_id)`,
`(check_in_id, tenant_id)`. This makes cross-tenant references
structurally impossible, not just filtered at query time.

Every query filters `WHERE tenant_id = ?` at the application level.
**RLS is enabled and forced** on every tenant-scoped table (v0.5.4).

### Auth

Bearer token in `Authorization: Bearer <jwt>`. Two strategies, chosen
at boot by `readIdpConfig`:

- **JWKS** (`JWKS_URL` set): the token is signed by an external identity
  provider. The guard fetches their JWKS, validates signature, `aud`,
  `iss`, and the tenant claim. `sub` maps to the agent id.
- **dev-secret** (`JWKS_URL` empty, non-production): the token is signed
  locally with `JWT_SECRET`, minted at `POST /auth/token`. The boot
  guards refuse to start in production without `JWKS_URL`.

Either way, `request.agentId` and `request.tenantId` are set to
validated UUIDs. Services never see a request without both.

## API contract

### POST /sync/pull

Request:

    {
      "last_pulled_at": 12345,
      "limit": 500
    }

Response:

    {
      "changes": {
        "check_ins": { "created": [], "updated": [], "deleted": [] },
        "missions":  { "created": [], "updated": [], "deleted": [] },
        "sites":     { "created": [], "updated": [], "deleted": [] }
      },
      "timestamp": 12500,
      "has_more": false
    }

`timestamp` is an opaque cursor, to be sent back as `last_pulled_at`
on the next call. `has_more` indicates pagination should continue
immediately.

### POST /sync/push

Headers: `Idempotency-Key: <uuid>` (optional but recommended).

Request:

    {
      "changes": {
        "check_ins": {
          "created": [ ... ],
          "updated": [ { "id": "...", "version": 42, ... } ],
          "deleted": [ "uuid1", "uuid2" ]
        }
      }
    }

Response:

    {
      "applied":  { "created": 1, "updated": 2, "deleted": 0 },
      "conflicts": [
        {
          "entity_type": "check_in",
          "entity_id": "...",
          "client_version": 42,
          "server_version": 45,
          "conflict_id": "..."
        }
      ]
    }

Push is transactional: on any technical error, the whole batch rolls
back. Conflicts are recorded but do not roll back the batch — they
represent a legitimate race the client must resolve.

**Idempotency TTL:** 7 days (row in `sync_idempotency_keys`).
**Max push size:** not enforced yet — see Debt.

### Error codes

- `400` — validation failure
- `401` — missing or invalid JWT
- `403` — resource not accessible (wrong tenant or agent)
- `404` — resource not found
- `409` — idempotency conflict or already-resolved conflict
- `410` — cursor too old, client must resync from scratch (not implemented, see Debt)

## Project layout

    migrations/          SQL migrations 001 to 007
    src/
      schema.ts
      sync-pull.service.ts
      sync-push.service.ts
      sync-conflict.service.ts
      sync-maintenance.service.ts
      sync-attachment.service.ts
      s3-attachment-storage.ts
      attachment-storage.ts
      (removed in c3bb9a7 — see v0.5.6 notes)
      sync.controller.ts
      sync-attachment.controller.ts
      auth.controller.ts
      jwt.guard.ts
      app.module.ts
      main.ts
    test/
      sync.integration.spec.ts     (31 tests)
      sync.http.spec.ts            (12 tests)
      auth.http.spec.ts            (4 tests)
      attachments.http.spec.ts     (11 tests)
      cursor-gaps.spec.ts          (2 tests)
      helpers/testcontainers-pg.ts
      helpers/jwt.ts

## Version history

    v0.1        Sync engine core                     9/9
    v0.2        Incremental missions + sites         14/14
    v0.3        Conflict detection (LWW)             20/20
    v0.3.1      Mission ownership on update          21/21
    v0.3.2      Conflict resolution                  28/28
    v0.3.3      Purge function                       31/31
    v0.3.4      HTTP layer                           37/37
    v0.3.5      JWT auth + bootstrap                 39/39
    v0.3.6      /auth/token                          43/43
    v0.4.1a     Multi-tenant schema                  43/43
    v0.4.1b     Tenant propagation                   47/47
    v0.5        Attachments (S3)                     58/58
    v0.5.1+2    Tenant lock + 410 stale cursors      67/67
    v0.5.3      Purge tombstones + watermark         71/71
    v0.5.4      Row-Level Security (a/b/c)           77/77

## Roadmap

Version numbers are linear. Priorities reflect the review of 2026-10-01:
correctness first, then the items that block external exposure, then
observability, then comfort features.

### v0.5.1 — Tenant lock + cursor gaps fix (done)

Per-tenant advisory lock taken at the start of every sync_seq-producing
transaction. Regression test in `test/cursor-gaps.spec.ts`.

Note: the lock was originally isolated in `src/tenant-write-lock.ts`.
As of v0.5.6 it is folded into `withTenant(db, tenantId, fn, { write: true })`,
and the separate file is gone.

### v0.5.2 — 410 GONE for stale cursors (done)

`sync_purge_state` per tenant, `purged_up_to_seq` raised in the same
transaction as the purge. `/sync/pull` returns 410 when
`last_pulled_at < purged_up_to_seq`. Tests in
`test/stale-cursor-410.spec.ts`.

### v0.5.4 — Row-Level Security (done)

RLS enabled and forced on every tenant-scoped table. `sync_app` is a
non-superuser role, subject to the policies, and every HTTP path runs
under it. Tests in `test/rls-isolation.spec.ts` and the harness canary
`test/app-role-canary.spec.ts`.

### v0.5.6 — Correctness fixes (done)

Four items from the 2026-10-01 review, all shipped:

- RLS proven on the HTTP paths. The specs used to inject a superuser
  connection; they now inject `pg.appDb` and fail if the role can
  bypass RLS. This surfaced a real bug in
  `AttachmentService.requestUpload` and `.confirmUpload`, fixed in the
  same commit.
- `sync_app` password removed from the repository. Migration 012 sets
  the role to `NOLOGIN`; the operator grants `LOGIN` with a generated
  password; the test helper re-enables it with a throwaway password
  inside the ephemeral container only.
- `requireTenantId` at every service entry point. The four
  `?? DEFAULT_TENANT_ID` fallbacks are gone. A caller that omits the
  tenant now gets a `BadRequestException` instead of writing to the
  zero tenant.
- Site orphan after mission reassignment. `check_ins.site_id` is
  denormalized at push time; the pull filter keeps a site as long as
  a mission OR a check-in links the agent to it. Migration 013.

### v0.6 — Real IdP (done)

External identity provider verified via JWKS (`jose`). Files:

- `src/idp.config.ts` — reads `JWKS_URL`, `JWT_AUDIENCE`, `JWT_ISSUER`,
  `JWT_TENANT_CLAIM`. Picks the strategy: `jwks` if `JWKS_URL` is set,
  `dev-secret` otherwise.
- `src/idp-token.ts` — `verifyToken(token, jwks, options)`. Pure: no I/O,
  no global state. Throws on any signature, expiry, audience, issuer, or
  claim failure.
- `src/jwt.guard.ts` — picks the strategy once at construction. In JWKS
  mode, uses `createRemoteJWKSet` and validates signature, `aud`, `iss`,
  and the tenant claim. In dev-secret mode, falls back to the local
  `JwtService` (used by `/auth/token` and the test suite).
- `src/boot-guards.ts` — `assertAuthStrategy`: in production, requires
  `JWKS_URL` and `JWT_AUDIENCE`. Elsewhere, if `JWKS_URL` is absent,
  requires a strong `JWT_SECRET`.
- `.env.example` — documents every variable.

Tests: `test/idp-token.spec.ts` (9 tests with a locally signed JWKS:
expiry, wrong audience, wrong issuer, wrong key, missing/non-UUID claims,
custom claim name). `test/boot-guards.spec.ts` gains 2 tests for the
new production requirements.

The provider is not hard-coded. Any OIDC-compliant endpoint works. If the
provider puts the tenant in a namespaced claim, set `JWT_TENANT_CLAIM`.

### v0.7 — Observability (done)

`sync_logs` table (RLS, append-only for sync_app), Prometheus metrics
on a dedicated authenticated port, per-call interceptor that writes
one row per /sync/* request. Tests in `test/metrics.spec.ts`,
`test/metrics-config.spec.ts`, `test/sync-logs-rls.spec.ts`,
`test/sync-log.spec.ts`.

### v0.7.5 — Maintenance foundation (done)

Two pieces that let maintenance jobs run:

- **Tenants registry** (`migrations/016`, `src/tenant-registry.ts`).
  `withTenant` registers every tenant it sees, so a cron can
  `SELECT id FROM tenants` to know which tenants to walk. The registry
  has no RLS by design: without a tenant context, every other table
  exposes zero rows.
- **`sync_logs` retention purge** (`migrations/015`). A
  `SECURITY DEFINER` function with a 30-day floor, tenant check, and a
  frozen `search_path`. `sync_app` has no `DELETE` on `sync_logs`
  (append-only since 014); the function runs the DELETE with the
  migration role's privileges.

Original v0.7 plan, for reference:

Shipped as a slightly different shape: one row per request with
request_id, operation, status, timing, record counts, conflicts,
idempotency, error code. Metrics cover requests, duration, records,
conflicts, idempotency, stale cursors, payload size.

**Remaining for a later pass:** the cron that calls
`SyncMaintenanceService.purgeSyncLogs` for every row in `tenants`. It
runs outside the app (systemd timer, k8s CronJob, or an equivalent
scheduler) once the deployment strategy is known.

### v0.8 — S3 purge and orphans (done)

Three related pieces, each in its own PR.

**1. Capture orphans before the cascade.**
`attachments.check_in_id` references `check_ins(id, tenant_id)` with
`ON DELETE CASCADE` (migration 007). When `purge_tenant_tombstones`
removes a soft-deleted check-in, its attachment rows go with it and the
`object_key` values are lost. Migration 017 replaces the function: it
collects the object keys that will be cascaded away, before the
`DELETE`, and returns them as `orphaned_object_keys` (TEXT[]).
`AttachmentStorage.delete()` added; `SyncMaintenanceService.purgeTenantStorage(storage, keys)`
iterates and best-effort deletes.

**2. Scan for orphans that predate step 1.**
`SyncMaintenanceService.scanTenantOrphans(storage, tenantId, options)`
lists the tenant's S3 prefix (via `listByPrefix`, `ListObjectsV2Command`
paginated), cross-checks against `object_key` values still referenced
by `attachments` rows, and reports the difference. Per tenant, because
reading the DB through `withTenant` means RLS scopes the row set. Two
safety features:

- `dryRun` defaults to `true`. Nothing is deleted without
  `dryRun: false`.
- A ratio guard refuses to delete if more than 50% of the listed
  objects would go. A suspiciously high orphan ratio usually means the
  DB read returned zero rows for a reason other than an empty table
  (RLS context lost, wrong tenant id). `allowHighOrphanRatio: true`
  overrides after manual review.

**3. Purge `pending` attachments never confirmed.**
`purgeTenantPendingAttachments(tenantId, ttlDays = 7)` deletes rows
with `status='pending'` older than the cutoff, inside `withTenant`. No
S3 object to touch: either the client never PUT anything, or the object
was written but never confirmed, and the scan from step 2 finds it.

All three run per tenant. The cron that walks `tenants` and calls each
of the maintenance methods is **still outside the repository** (see the
note under v0.7.5).

### v0.9 — SSE

Notification only. A periodic pull is sufficient for a first deployment.

- `DATA_CHANGED` event per tenant.
- Client re-pulls on receipt. Server sends no data.

### v1.0 — API versioning

Nice to have when a second client version exists. Not a blocker for a
single-app deployment.

- `X-Schema-Version` and `X-Client-Version` headers.
- `426 Upgrade Required` on mismatch.

## Debt / Known issues

- **Tenants registry has no retention.** `tenants` grows by one row
  per new tenant, forever. That is bounded by the number of distinct
  tenants, which is small, so it is acceptable for now. If it ever
  needs pruning, add a `last_seen_at` column updated on every request
  and purge inactive tenants older than N months.


- **Migration 013 backfill is approximate.** `UPDATE check_ins
  SET site_id = m.site_id FROM missions m WHERE ...` attaches
  historical check-ins to the *current* site of their mission. For a
  check-in created before a reassignment, this writes the new site, not
  the one the agent actually visited. Check-ins pushed after migration
  013 are exact: `sync_push` stamps `site_id` at insert time from the
  mission's site at that moment. Only the historical rows are wrong, and
  only when a reassignment happened *before* 013 ran. There is no way to
  recover the pre-013 site from the current schema; if it matters, the
  information must be restored from backups or from the client's local
  copy.


| Item | Severity | Notes |
|---|---|---|
| No real IdP | High | `/auth/token` is dev-only. |
| No prod guard on `AUTH_ALLOW_DEV_TOKEN` | High | App boots with dev flag in production. Add `NODE_ENV` check. |
| Purge vs offline clients | High | A client offline longer than retention never learns of deletions. Needs `410 GONE` on stale cursor. |
| Upload validation incomplete | Medium | Presigned PUT cannot enforce size or content-type. HEAD `confirm` must reject on mismatch. v0.5.4. |
| Orphan attachments | Medium | Pending rows never confirmed, and S3 objects without rows, are not cleaned up. v0.5.4. |
| S3 purge after soft-delete | Medium | Objects stay in bucket forever. v0.5.5. |
| No CI | Medium | A GitHub Action on `ubuntu-latest` answers the "does it run on Mac/Linux" question on every commit. |
| No dev script | Low | `npm run dev` referenced but not defined. Add `tsx watch src/main.ts`. |
| Test execution ~90s | Low | Each test file spawns its own PG container. Vitest `globalSetup` + schema-per-file would cut this to ~30s. |
| Schema drift potential | Low | `src/schema.ts` and migrations can desync silently. Add a test that applies migrations to a fresh container and compares with the Drizzle schema. |
| Max push size not enforced | Low | A client can send an arbitrarily large batch. |

## Working conventions

- Commit + tag immediately after green tests.
- Test before fix. Every bug found in v0.1–v0.5 was caught by a test.
- Never modify `src/schema.ts` without a matching migration.
- Prefer Node `.cjs` scripts over PowerShell here-strings for
  multi-line patches on Windows. PowerShell 5.x breaks on backticks
  inside TypeScript and SQL string literals, producing
  unterminated-string errors that are hard to trace.

## Open questions

- **Mobile stack.** WatermelonDB targets React Native only, not
  Flutter. If Flutter is the real target, the sync protocol shape
  (`{ changes, timestamp }`) can be revisited; if RN, keep as-is.
  **Decision needed before v0.6.**
- **Conflict resolution UI.** Conflicts accumulate in `sync_conflicts`
  with no resolution path other than the API. Who resolves them, and
  how?
- **Merge semantics.** LWW is fine for scalar fields. If two clients
  edit different fields of the same check-in, LWW loses one. Future
  work may need field-level merge (JSON Patch or similar).

## Environment variables

| Var | Required in prod |
|---|---|
| DATABASE_URL | yes |
| JWT_SECRET | yes (min 32 chars — add boot check) |
| PORT | no (default 3000) |
| AUTH_ALLOW_DEV_TOKEN | **must be false in prod** (add boot check) |
| S3_BUCKET | yes |
| S3_REGION | yes |
| S3_ENDPOINT | no (MinIO) |
| S3_ACCESS_KEY_ID | yes |
| S3_SECRET_ACCESS_KEY | yes |

## Contact

<ton nom>
<email>
<GitHub: @tshibandachris>