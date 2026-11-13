![CI](https://github.com/tshibandachris/sync-engine/actions/workflows/ci.yml/badge.svg)

# Sync Engine — Handoff

## What it is

Multi-tenant synchronisation engine for a field-agent mobile app.
Mobile stack: **React Native + WatermelonDB** (to be confirmed — see Open questions).

- Incremental pull/push of `check_ins`, `missions`, `sites`
- Conflict detection + resolution (LWW on `sync_seq`)
- Idempotent push: request key and POS sale records share one PostgreSQL transaction; sale UUID retries compare persisted sale, line, and stock-movement content (see POS sales push atomicity below)
- JWT auth with tenant scoping
- S3 presigned uploads for incident photos

**Current state:** the repository now includes signed device approval/sync, atomic POS push handling, tenant RLS, and a separate maintenance runner. This document describes repository code only; it does not imply that a real database migration or deployment has occurred.

## Stack

- Node.js 22+ (CI runtime)
- TypeScript (ESM, `type: module`)
- NestJS 12 for HTTP
- Drizzle ORM + PostgreSQL 16
- Vitest 5
- Testcontainers (real PostgreSQL per test file)
- AWS SDK v3 (S3)

## Quick start

    git clone https://github.com/tshibandachris/sync-engine.git
    cd sync-engine
    npm ci
    npm run typecheck
    npx vitest run

Requirements: Docker running for Testcontainers. CI runs the backend, PostgreSQL 16 migration/recovery, Electron, and Windows packaging checks; local duration depends on Docker and machine capacity.

### Running the app locally

    cp .env.example .env
    # fill the variables in .env.example; keep .env local and uncommitted
    npx tsx src/main.ts

`npm run dev` is not defined yet — see Debt / "no dev script". The checked-in `.env.example` is the source of truth for the current separate application, device-admin, device-enrollment, and maintenance credentials, plus the JWKS and S3 settings.

### Manual upload/download E2E test (isolated test stack)

This is an opt-in manual test and is **not part of any GitHub Actions
workflow**. It uses its own Compose project, database and storage volumes,
loopback-only ports, and `NODE_ENV=test`; it does not use
`docker-compose.prod.yml` or `.env.prod`.

    cp .env.test.example .env.test
    # Replace every REPLACE_WITH_ marker with a disposable test value.
    docker compose -p sync-engine-e2e-test -f docker-compose.test.yml --env-file .env.test up -d --build
    npm run test:e2e:upload
    docker compose -p sync-engine-e2e-test -f docker-compose.test.yml --env-file .env.test down

The API is available only at `http://127.0.0.1:3300`; the test object
store is published only on loopback port 8334. The script refuses to run
unless `NODE_ENV=test` and a sufficiently long test JWT secret are set.
To remove only the isolated test data after review, append `-v` to the
final `down` command. Never point this stack at production resources.

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
- Maintenance retention functions use the dedicated maintenance database login and do not participate in the sync-sequence write path.

**Why:** `nextval('global_sync_seq')` is not transactional. Without a
lock, a transaction that obtains seq N can commit after one that
obtained seq N+1, leaving a gap. A client pulling between the two
commits advances past the gap and never sees the earlier row.

**Cost:** all pushes of a single tenant are serialised. At 10k agents
on the same tenant, a peak at shift start becomes a queue. Documented
trade-off for correctness. The alternative is a transactional outbox
fed by a non-cached sequence — a larger refactor, deliberately
deferred.

### POS sales push atomicity

The `/sync/push` transaction owns the request idempotency-key row,
POS sale writes, and every other operation in the same request. For a
request carrying an idempotency key, any invalid or conflicting POS sale
aborts the outer transaction. PostgreSQL therefore rolls back the key,
all successful sale savepoints, and all non-POS changes together; the
client can retry the same key after correcting the payload. The service
does not delete the key and commit a partially applied request.

Each sale is written inside a PostgreSQL savepoint, so its sale row, all
sale lines, and all stock movements commit or roll back together. For
unkeyed POS pushes, per-sale savepoint behavior remains independent:
valid sales can be accepted while an invalid sale is reported.

A sale UUID is inserted with `ON CONFLICT (id) DO NOTHING`. If another
request already inserted it, the service reloads the sale and compares
the persisted client-owned fields, lines, and sale-referenced stock
movements. Matching content returns `idempotent`; differing content
returns `conflict`. Client-supplied `created_at` values are preserved.
The shared `set_sync_fields()` trigger generates `updated_at` on insert,
so that server-managed value is deliberately excluded from replay
comparison for sales, lines, and stock movements.

Tenant transactions explicitly use PostgreSQL `READ COMMITTED`.
This is required for the `ON CONFLICT DO NOTHING` followed by reread
pattern: after waiting for a concurrent insert, the next statement sees
the committed row. Production `/sync/push` requests also take the
existing tenant write lock; the independent concurrency test exercises
the UUID insert path without that lock, while an HTTP-level test covers
the production path.

The guarantee is limited to these persisted records and the tested
request paths; it is not a blanket claim that all client operations can
never be duplicated.

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

**Known limitation:** presigned PUT cannot enforce size/type at the object-store edge. `confirm` performs a HEAD request but currently checks existence only; it does not compare the stored content length or content type with the attachment row. Keep this as an open debt until a test proves those checks.

### Multi-tenancy

`tenant_id` column on 6 tables: `sites`, `missions`, `check_ins`,
`sync_conflicts`, `sync_idempotency_keys`, `attachments`.

Composite FKs: `(site_id, tenant_id)`, `(mission_id, tenant_id)`,
`(check_in_id, tenant_id)`. This makes cross-tenant references
structurally impossible, not just filtered at query time.

Every query filters `WHERE tenant_id = ?` at the application level.
**RLS is enabled and forced** on every tenant-scoped table (v0.5.4).

### Auth

Production uses Supabase Auth with asymmetric JWKS verification only (ES256
or RS256). The API validates the token signature, issuer (`iss`), audience
(`aud`), expiry, `sub`, and the UUID business claims `agent_id` and
`tenantId`. A Supabase Custom Access Token Hook must copy those two claims
from server-managed `app_metadata`; mutable `user_metadata` is never trusted.
Production Compose requires `JWKS_URL`, `JWT_ISSUER`, and
`JWT_AUDIENCE`. No shared JWT secret is permitted in production.

Local development and automated tests can use HS256 with `JWT_SECRET`
when `JWKS_URL` is unset. The offline token-minting scripts explicitly
refuse to run when `NODE_ENV=production`. They are not a production
administrator-token issuance workflow.

**Dettes centralisées :**
- Le flux de connexion, de renouvellement du jeton et de persistance de
  session Supabase du POS Electron est suivi dans la dette **#5** de
  « Debt / Known issues ».
- L'obtention et les permissions du jeton administrateur de production
  sont suivies dans la dette **#6** de cette même liste.

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

Push is transactional: on a technical error, the whole batch rolls
back. Check-in conflicts are recorded without rolling back the batch.
For requests carrying an idempotency key, an invalid or conflicting POS
sale aborts the whole push so no other operation can commit without its
key.

**Idempotency TTL:** 7 days (row in `sync_idempotency_keys`).
**Max push size:** not enforced yet — see Debt.

### Error codes

- `400` — validation failure
- `401` — missing or invalid JWT
- `403` — resource not accessible (wrong tenant or agent)
- `404` — resource not found
- `409` — idempotency conflict or already-resolved conflict
- `410` — cursor too old; the client must resync from scratch.

## Project layout

    migrations/          SQL migrations 001 to 042
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

### v0.6 — Real IdP (production configuration required)

External identity provider verification via asymmetric JWKS is implemented
in `src/idp-token.ts` and `src/jwt.guard.ts`. Production boot guards
require JWKS URL, issuer and audience and reject local shared-secret
authentication. Supabase is the documented production provider; its
Custom Access Token Hook must supply UUID claims `agent_id` and
`tenantId` from server-managed `app_metadata`.

The API-side verification code and unit tests exist. A real Supabase
project configuration remains to be completed. The POS Electron session
flow and production administrator-token acquisition are tracked centrally
in debts #5 and #6 under "Debt / Known issues".

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

The scheduled maintenance path is implemented by `src/maintenance-orchestrator.ts` and `src/maintenance-runner.ts`. It connects through `MAINTENANCE_DATABASE_URL` as `maintenance_login`, not through the API login.

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

All three run per tenant. `runMaintenanceCycle` walks the tenant registry and calls the maintenance service; the runner keeps the orphan-object scan in dry-run mode.

### v0.9 — SSE

Notification only. A periodic pull is sufficient for a first deployment.

- `DATA_CHANGED` event per tenant.
- Client re-pulls on receipt. Server sends no data.

### v1.0 — API versioning

Nice to have when a second client version exists. Not a blocker for a
single-app deployment.

- `X-Schema-Version` and `X-Client-Version` headers.
- `426 Upgrade Required` on mismatch.

## État du déploiement d’essai

- **Contrôles faits (résultats rapportés) :** Gitleaks sur l’historique complet avec un faux positif ; preuve rouge de la migration 042 ; test de reprise des migrations.
- **Non configuré :** secrets GitHub, projet Supabase, bucket et jeton R2, service Render.
  - Parmi les secrets GitHub à créer : `RENDER_MAINTENANCE_DATABASE_URL`, avec l’URL externe de la base et `sslmode=require` pour le workflow de purge ; le service Web utilisera l’URL interne. Les deux URLs doivent utiliser le même mot de passe, généré en hexadécimal. Aucune valeur de secret ne doit être stockée dans le dépôt.

## Debt / Known issues

1. **Séparation du credential de maintenance.** `MAINTENANCE_PASSWORD` est le secret d’authentification du rôle PostgreSQL `maintenance_login` ; le script de migration l’utilise pour provisionner ce rôle. Ce secret n’est pas, à lui seul, une connexion active. `MAINTENANCE_DATABASE_URL` est la chaîne de connexion construite avec ce credential : c’est elle qui permet au processus qui la reçoit d’ouvrir une session PostgreSQL. Le runner applicatif `src/maintenance-runner.ts` exécute le cycle de maintenance et utilise cette connexion ; actuellement, la chaîne est fournie au service API pour lancer ce runner, de sorte que l’environnement du service API détient le credential. À distinguer du script `scripts/migrate.sh`, qui applique les migrations SQL et provisionne les rôles. Avant toute utilisation de données réelles, isoler le runner de maintenance dans un service ou processus dédié et ne lui fournir qu’à lui `MAINTENANCE_DATABASE_URL`.
2. **Contrôle du rôle applicatif incomplet.** Dans `src/role-guard.ts`, ajouter les contrôles `rolinherit`, `rolcreatedb`, `rolcreaterole` et `rolreplication`, puis appeler ce contrôle au démarrage de l’API ; actuellement, il est appelé dans `maintenance-runner.ts` seulement.
3. **Vérification du ledger par comptage seulement.** Le workflow compare le nombre de fichiers SQL au nombre d’entrées du registre ; comparer également les noms exacts des migrations appliquées aux fichiers présents.
4. **Pas de garde de complétude du registre au démarrage de l’API.** En dehors de la dépendance `service_completed_successfully` de Docker Compose, l’API ne bloque pas son démarrage lorsque le registre des migrations est incomplet.
5. **Identité et session POS Electron non intégrées.** Le client Electron n’intègre pas de fournisseur d’identité (voir README) : le jeton est provisionné hors de l’application. Le flux de connexion, de renouvellement du jeton et de gestion de session Supabase du POS n’est pas implémenté.
6. **Jeton administrateur de production non démontré.** Le mécanisme d’obtention du jeton administrateur en production reste à définir et à valider.
7. **Cloudflare R2 : validation réelle non démontrée.** L’adaptateur S3 dispose de tests unitaires. En revanche, l’intégration réelle à Cloudflare R2, les permissions du jeton et les opérations sur le bucket ne sont pas démontrées. Avant validation, utiliser un bucket R2 de test dédié et un jeton limité à ce bucket, puis vérifier upload, confirmation, téléchargement et nettoyage ; ne pas utiliser le bucket de production ni un jeton largement autorisé.
8. **Audit des dépendances à réaliser.** `npm audit` est à exécuter ; 12 vulnérabilités ont été signalées, dont 4 de niveau `high` (résultat rapporté, à confirmer par l’audit). Compléter ce point après l’audit.
9. **Faux positif Gitleaks connu.** Une clé d’idempotence de test est signalée à tort ; l’empreinte exacte est documentée dans `.gitleaksignore`.
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
| Upload validation incomplete | Medium | Presigned PUT cannot enforce size or content-type. HEAD `confirm` must reject on mismatch. v0.5.4. |
| No dev script | Low | `npm run dev` referenced but not defined. Add `tsx watch src/main.ts`. |
| Test execution ~90s | Low | Each test file spawns its own PG container. Vitest `globalSetup` + schema-per-file would cut this to ~30s. |
| Schema drift potential | Low | `src/schema.ts` and migrations can desync silently. Add a test that applies migrations to a fresh container and compares with the Drizzle schema. |
| Max push size not enforced | Low | A client can send an arbitrarily large batch. |

## Maintenance security and migration execution

- Migrations 039–041 leave migration 039 unchanged, revoke the API/public purge grants in later migrations, and assign the idempotency/conflict, nonce, tombstone, and sync-log purge entry points to the maintenance capability.
- `maintenance_login` inherits only `maintenance_purge_executor`; the function owner is a separate `NOLOGIN` role. The login has no direct business-table `INSERT`, `UPDATE`, or `DELETE` privileges.
- Nonce cleanup is tenant-scoped, accepts a caller-supplied batch size, and rejects values above 10,000; tests cover a one-row batch and rejection above the limit. Tombstone and sync-log cleanup are tenant-scoped and capped at 5,000 rows per invocation; tests verify that the next expired row remains for a later cycle.
- `scripts/migrate.sh` applies each migration and its ledger row in one transaction protected by a PostgreSQL advisory transaction lock. The `--migrations-only` switch is a test seam; normal deployment execution still provisions the isolated logins.
- `test/migrate-resume.spec.ts` exercises failure rollback, corrected retry, replay, concurrent runners, and the failure of `CREATE INDEX CONCURRENTLY` inside the transactional runner. CI status is the source of truth for whether these tests have passed.

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

## Operations

### Scheduling the maintenance cycle

`npm run maintenance:purge` runs one cycle over every tenant in the
registry (migration 016): sync_logs purge, pending attachments purge,
tombstone purge plus storage cleanup, and a dry-run orphan scan. It
prints a JSON report on stdout and exits 0 on success, 1 if any tenant
failed.

The runner is a batch job, not part of the API. No HTTP endpoint:
a long purge over many tenants would hold a request open, and a leaked
ops token would let anyone issue DELETEs. A command line makes the
surface a single binary that runs where the database runs.

In a Docker Compose deployment, the simplest way to schedule it is
`ofelia`, a Docker-native cron that reads job labels from the compose
file.

    services:
      sync-engine:
        # ... existing service ...
        labels:
          ofelia.enabled: "true"
          ofelia.job-exec.maintenance.schedule: "0 0 3 * * *"
          ofelia.job-exec.maintenance.command: "node /app/dist/maintenance-runner.js"

      ofelia:
        image: ghcr.io/netresearch/ofelia:1.0.1
        depends_on: [sync-engine]
        command: daemon --docker
        volumes:
          - /var/run/docker.sock:/var/run/docker.sock:ro

When the self-hosted Docker Compose stack is running, ofelia schedules `node dist/maintenance-runner.js` daily at 03:00; logs are available with `docker logs sync-engine`. This is the Compose scheduler only, not a Render Free cron. Render's manual migration and scheduled maintenance workflows are prepared on PR #96 and are not enabled on the default branch. No real database migration or deployment has been run.

Two properties of the runner worth knowing before trusting it with a
production database:

- **Session-level advisory lock.** Two runners can overlap by accident
  (a timer fires while an operator runs one by hand). The second one
  returns `skipped: true` and does nothing. The scheduler treats that
  as success.
- **Scan always dry-run.** `scanTenantOrphans` runs with `dryRun:
  true` from the scheduler, unconditionally. Real orphan deletion
  requires an operator to review the report and run the scan again
  with `dryRun: false` for a specific tenant. A cron that deletes S3
  objects on its own is a data-loss incident waiting to happen.

### Container image

The checked-in Dockerfile already builds TypeScript in a Node 22 builder stage, copies `dist/` into a production runtime image, and runs as the non-root `node` user. The API and maintenance runner use compiled JavaScript. CI builds the image and smoke-tests its entrypoint; this does not mean the image has been deployed.

### Scheduler caveats

- **Cron format.** ofelia's cron starts with a seconds field. Write six
  fields (`0 0 3 * * *`) so the schedule parses the same on every
  version, and run `ofelia validate` on the configuration before
  deploying.
- **Docker socket.** `docker.sock:ro` does not restrict what the Docker
  API accepts: a process holding the socket can start privileged
  containers. Treat the ofelia container as root on the host. If that is
  not acceptable, run the cycle from a host timer instead:
  `docker compose run --rm sync-engine node dist/maintenance-runner.js`.
- **Alerting.** Exit code 1 is only logged by the scheduler. Wire a
  notification (an ofelia middleware) or a success ping to a monitoring
  service (dead-man's switch), otherwise a broken purge goes unnoticed
  for months.
- **Trusted host.** In label mode, a container can define jobs on itself.
  Run ofelia on a host that only runs trusted containers, keep the
  version pinned at 0.29.1 or later (security release for this case),
  and check in the ofelia README that `ofelia.enabled` restricts which
  containers are read.
## Environment variables

| Variable | API production | Migration service | Notes |
|---|---:|---:|---|
| `NODE_ENV` | Required | — | Must be `production` |
| `DATABASE_URL` | Required | — | Built from `SYNC_APP_PASSWORD` |
| `DEVICE_ENROLLMENT_DATABASE_URL` | Required | — | Built from `DEVICE_ENROLLMENT_PASSWORD` |
| `DEVICE_ADMIN_DATABASE_URL` | Required | — | Built from `DEVICE_ADMIN_PASSWORD` |
| `JWKS_URL` | Required | — | Supabase public JWKS endpoint |
| `JWT_ISSUER` | Required | — | Supabase issuer |
| `JWT_AUDIENCE` | Required | — | Usually `authenticated`; confirm against the test project |
| `JWT_SECRET` | Forbidden | — | HS256 is development/test only |
| `AUTH_ALLOW_SHARED_SECRET` | Forbidden | — | No production shared-secret mode |
| `METRICS_PORT` | Required | — | Dedicated metrics listener |
| `OPS_METRICS_TOKEN` | Required | — | Minimum 32 characters |
| `S3_BUCKET` | Required | — | Production object bucket |
| `S3_ACCESS_KEY_ID` | Required | — | S3-compatible provider |
| `S3_SECRET_ACCESS_KEY` | Required | — | S3-compatible provider |
| `S3_REGION` | Configured | — | Provider-specific region |
| `S3_ENDPOINT` | Optional | — | Required for R2/MinIO; optional for AWS S3 |
| `S3_PUBLIC_ENDPOINT` | Optional | — | Public endpoint for presigned URLs |
| `POSTGRES_PASSWORD` | — | Required as `PGPASSWORD` | PostgreSQL administrator login |
| `SYNC_APP_PASSWORD` | Used in DB URL | Required | Provisions `sync_app` |
| `DEVICE_ENROLLMENT_PASSWORD` | Used in DB URL | Required | Provisions enrollment login |
| `DEVICE_ADMIN_PASSWORD` | Used in DB URL | Required | Provisions device-admin login |
| `MAINTENANCE_PASSWORD` | — | Required | Provisions maintenance login; never passed to API |
| `DB_HOST`, `DB_NAME`, `DB_USER`, `MIGRATIONS_DIR` | — | Optional | Have safe script defaults |

The production Compose file supplies all boot-guard requirements for
`sync-engine`; the actual Supabase project values and provider credentials
must still be supplied outside Git.

## Contact

<ton nom>
<email>
<GitHub: @tshibandachris>