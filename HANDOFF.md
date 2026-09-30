# Sync Engine — Handoff

## What it is

Multi-tenant synchronisation engine for a field-agent mobile app
(Flutter/React Native + WatermelonDB).

- Incremental pull/push of `check_ins`, `missions`, `sites`
- Conflict detection + resolution (LWW via `sync_seq`)
- Idempotent push (advisory locks + idempotency keys)
- JWT auth with tenant scoping
- S3 presigned uploads for incident photos

**Current state: v0.5, 58 tests green, working tree clean.**

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

Requirements: Docker running. First run pulls `postgres:16-alpine` (~60s).

## Architecture

### Sync protocol

Four routes:

| Route | Purpose |
|---|---|
| POST /sync/pull | Get changes since cursor (`sync_seq`) |
| POST /sync/push | Send local changes (versioned, idempotent) |
| GET /sync/conflicts | List pending conflicts |
| POST /sync/conflicts/:id/resolve | Resolve (client/server/dismiss) |

**Cursor:** one global sequence (`global_sync_seq`) shared across
`sites`, `missions`, `check_ins`. Ensures coherent cross-table ordering.

**Conflict model:** each row has `sync_seq`. Clients send `version`
in updates. If `version < server.sync_seq`, write goes to
`sync_conflicts` instead of being applied. LWW for now.

### Attachments

| Route | Purpose |
|---|---|
| POST /attachments/request-upload | Creates pending row + presigned PUT URL (15 min) |
| POST /attachments/:id/confirm | HEAD-checks S3, marks uploaded |
| GET /attachments?check_in_id=... | Lists uploaded + presigned GET URLs (1h) |

S3 never proxied. Client uploads directly.

### Multi-tenancy

- `tenant_id` on 5 tables
- Composite FKs: `(site_id, tenant_id)`, `(mission_id, tenant_id)`,
  `(check_in_id, tenant_id)`
- Every query filters `WHERE tenant_id = ?` (app-level)
- **RLS NOT enabled yet** — see Debt below.

### Auth

JWT Bearer with `{ sub: agentId, tenantId }`. `/auth/token` issues
tokens, gated behind `AUTH_ALLOW_DEV_TOKEN=true` (dev only).

**Not production-ready:** no real IdP. Replace `/auth/token` with
OAuth2 / Azure AD B2C / real credential store in prod.

## Project layout

    migrations/          SQL migrations 001 to 007
    src/
      schema.ts          Drizzle schema
      sync-pull.service.ts
      sync-push.service.ts
      sync-conflict.service.ts
      sync-maintenance.service.ts
      sync-attachment.service.ts
      s3-attachment-storage.ts
      attachment-storage.ts
      sync.controller.ts
      sync-attachment.controller.ts
      auth.controller.ts
      jwt.guard.ts
      app.module.ts
      main.ts
    test/
      sync.integration.spec.ts   (31 tests)
      sync.http.spec.ts          (12 tests)
      auth.http.spec.ts          (4 tests)
      attachments.http.spec.ts   (11 tests)
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

## Debt / Known issues

| Item | Severity | Notes |
|---|---|---|
| RLS not enabled | High (prod) | App-level filters only. A missed WHERE leaks across tenants. |
| Triggers `trg_*_default_tenant` still active | Low | Safety net for INSERTs missing tenant_id. Remove in v0.4.2. |
| No real IdP | High (prod) | /auth/token is dev-only. |
| S3 purge after soft-delete | Medium | Objects stay in bucket forever. v0.5.1. |
| Test execution ~90s | Low | Each test file spawns its own PG container. |
| Schema drift potential | Low | src/schema.ts and migrations can desync silently. |

## Next steps

1. **v0.4.2 — RLS.** Enable RLS + policies. Introduce
   `withTenant(db, tenantId, fn)` wrapper doing
   `SET LOCAL app.current_tenant_id`. Rewrite all test seeds.
   Remove temporary triggers.

2. **v0.5.1 — S3 purge.** Job + `DeleteObject` for attachments
   whose check-in has been soft-deleted > 30 days.

3. **v0.6 — API versioning.** Headers `X-Schema-Version`,
   `X-Client-Version`. Reject mismatches with 426.

4. **v0.7 — SSE.** A `DATA_CHANGED` event per tenant.

5. **v0.8 — Observability.** `sync_logs` table + metrics.

## Working conventions

- Commit + tag immediately after green tests.
- Test before fix. Every bug found in v0.1-v0.5 was caught by a test.
- Prefer Node `.cjs` scripts over PowerShell here-strings for patches.
- Never modify `src/schema.ts` without a matching migration.

## Environment variables

| Var | Required in prod |
|---|---|
| DATABASE_URL | yes |
| JWT_SECRET | yes |
| PORT | no (default 3000) |
| AUTH_ALLOW_DEV_TOKEN | **no — must be false in prod** |
| S3_BUCKET | yes |
| S3_REGION | yes |
| S3_ENDPOINT | no (MinIO) |
| S3_ACCESS_KEY_ID | yes |
| S3_SECRET_ACCESS_KEY | yes |

## Contact

<ton nom / email / slack>