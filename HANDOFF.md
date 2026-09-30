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
- Helper: `src/tenant-write-lock.ts` → `lockTenantWrites(tx, tenantId)`.
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
- `lockTenantWrites(tx, tenantId)` - write paths. Same `set_config`,
  plus the tenant-level advisory lock.

**Paths that use them:**

| Service | Method | Wrapper |
|---|---|---|
| SyncPullService | pullChanges | withTenant |
| SyncConflictService | listConflicts | withTenant |
| SyncAttachmentService | listForCheckIn | withTenant |
| SyncMaintenanceService | purgeTenantTombstones | withTenant |
| SyncPushService | pushChanges | lockTenantWrites |
| SyncConflictService | resolveConflict | lockTenantWrites |

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
**RLS is not enabled yet** — see Roadmap v0.5.3.

### Auth

JWT Bearer with payload `{ sub: agentId, tenantId }`. `/auth/token`
issues tokens, gated behind `AUTH_ALLOW_DEV_TOKEN=true`.

**Not production-ready:** no real IdP. Replace `/auth/token` with
OAuth2 / Azure AD B2C / real credential store before any external
exposure.

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
      tenant-write-lock.ts
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

Version numbers below were chosen to be linear — prior drafts had
"v0.4.2" appearing after "v0.5" in the tag list, which was confusing.

### v0.5.1 — Tenant lock + cursor gaps fix (done)

Implemented. See the "Write serialisation" block above.

- `src/tenant-write-lock.ts` — `lockTenantWrites(tx, tenantId)`.
- Applied in `SyncPushService.pushChanges` and
  `SyncConflictService.resolveConflict`.
- Regression test: `test/cursor-gaps.spec.ts`. Red before the fix,
  green after. Log line `B finished while A was still open` flips
  from `true` to `false`.

### v0.5.2 — 410 GONE for stale cursors

The purge function (v0.3.3) deletes rows older than retention. A
client offline longer than retention never learns those rows were
deleted.

Design:

- The purge records a `purged_up_to_seq` per tenant. Table:
  `sync_purge_state(tenant_id UUID PRIMARY KEY, purged_up_to_seq BIGINT, updated_at BIGINT)`.
- `/sync/pull` returns `410 GONE` when
  `last_pulled_at < purged_up_to_seq` for the requesting tenant.
- Client must resync from scratch (full pull, no cursor).
- Retention policy documented in the API contract.

Regression test: a client pulls with a cursor below
`purged_up_to_seq` and receives 410.

### v0.5.4 — Row-Level Security (done)

Implemented across a/b/c. See the "Row-Level Security" architecture
block above and `test/rls-isolation.spec.ts` for the proof.

### v0.5.5 — S3 purge + orphan cleanup

- Purge attachments whose check-in has been soft-deleted > 30 days.
- Purge `pending` attachments never confirmed > 7 days.
- Scan for S3 objects without a matching row.
- Must run inside `withTenant` or with an explicit list of tenants.

### v0.6 — API versioning

Headers `X-Schema-Version`, `X-Client-Version`. Reject mismatches
with `426 Upgrade Required`.

### v0.7 — SSE

A `DATA_CHANGED` event per tenant. Client re-pulls on receipt.
Server sends notification only, not data.

### v0.8 — Observability

`sync_logs` table + metrics: push latency, conflict rate, idempotency
hit rate, average payload size.

## Debt / Known issues

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