# Eden Gestion — architecture Electron (V1)

Status: decisions for the walking skeleton; this document evolves with reviewed PRs.

## Product boundary

The Electron client is a separate application in `electron-app/`, kept beside the NestJS sync engine. It must use the real API contract and real data. No mock data in the runtime path.

## Decisions

1. **Identity and authentication:** distinguish installation identity from cashier identity. The device JWT identifies the installation and tenant; each sale carries the acting `staff_id`. The sales-push handler must verify the staff belongs to the JWT tenant (equivalent to `SELECT 1 FROM staff WHERE id = $staff_id AND tenant_id = $tenant_from_jwt`) before inserting the sale. This check belongs in the sales-push domain handler, not generic middleware. Record the device/agent identity for audit.
2. **Offline PIN:** a local PIN unlocks the cashier UI but is not server-side identity proof. Store only a password hash locally. Provision staff PIN hashes through a dedicated authenticated enrollment flow; never copy them from the normal sync feed.
3. **Device enrollment and token lifecycle:** the development skeleton may receive `EDEN_SYNC_TOKEN` from the environment, never committed to source control. For distribution, the selected direction is a one-time installation code exchanged through a dedicated registration endpoint for a short-lived access JWT and a rotating refresh credential. Target access-token TTL: 15 minutes; refresh credential TTL: 30 days, revocable per installation and stored in OS-backed secure storage. Refresh on 401/near expiry; if refresh fails, show an actionable authentication error and retain local data. This production flow is not implemented yet and is a release blocker; do not ship a shared tenant JWT or a 30-day access JWT.
4. **SQLite:** `better-sqlite3`, one database per Windows installation at `%APPDATA%/EdenGestion/data.db`. Multiple Windows users on one PC do not automatically share the same AppData path; sharing one database across Windows accounts is not a V1 guarantee.
5. **Transport:** direct HTTP(S) to NestJS. No proxy or WebSocket in V1. Poll every 30 seconds only after durable pull state and retry/backoff are implemented.
6. **Connectivity and visible status:** do not trust `navigator.onLine`. Derive status from actual API requests; retain local data on failure and retry with bounded backoff. The application window must show syncing/success/failure, the last successful sync time, and an explicit offline/authentication error. A failed pull must never look like a successful sync.
7. **Receipt printer:** USB ESC/POS thermal printer, 80 mm first. Keep printing behind an adapter so a later driver/library choice does not leak into sale logic. Validate target printers on Windows before promising model compatibility.
8. **Local schema:** numbered, forward-only local migrations recorded in SQLite (`schema_migrations`). Never delete the local database to upgrade it. Back up before migrations that may rewrite data.
9. **Native module build:** `better-sqlite3` must be rebuilt for Electron's Node ABI after dependency installation via `@electron/rebuild`. On Windows, a source build may require Python 3 and Visual Studio Build Tools with the Desktop development with C++ workload. The successful `node -e "require('better-sqlite3')"` test under system Node does not prove Electron compatibility.

## Pull cursor contract

The backend currently exposes one global `timestamp` cursor across the entity feed. The Electron client commits each returned page in one SQLite transaction: product rows are upserted into `products`, staff and cash sessions are also upserted into their queryable local tables, and every other returned entity (including sales, sale lines, stock movements, check-ins, missions, and sites) is durably retained in `synced_entities`. The global cursor is updated in that same transaction only after the full page validates and persists. This is safe only while the response includes every entity type covered by that cursor and the client commits the entire page atomically.

If a future implementation filters entity types, commits entity buckets independently, or stops retaining any returned entity, introduce independent per-entity cursors (for example `last_pulled_at_products`, `last_pulled_at_staff`, `last_pulled_at_sales`, and `last_pulled_at_stock_movements`) with corresponding server high-water marks. Never advance a cursor for changes that were not durably persisted.

## Walking skeleton scope

- Electron main process opens a minimal window.
- Preload exposes a small, explicit IPC surface; renderer has no Node integration.
- Startup creates the SQLite tables, then makes an authenticated `POST /sync/pull` with `{ "last_pulled_at": 0 }`.
- Current backend contract: `POST /sync/pull`, not GET `/sync/pull?since=0`. Response cursor is `timestamp`; products arrive under `changes.products.created`, `updated`, and `deleted`.
- Persist product changes with parameterized SQLite statements. Do not persist the global cursor until all returned entity types are durably stored.
- Display local product count and the outcome of the real pull. No sale UI, PIN flow, outbox push, or printing in this milestone.

## Security and operations

- Never commit a real token or secret. The environment token is development-only; packaged builds require the enrollment/refresh flow above.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and a narrow preload API. Renderer code must call only the API exposed as `window.eden.*`; no direct filesystem access or Node `require()`.
- Validate response shapes and enforce HTTPS outside explicitly local development.
- A failed pull must not erase local records or advance any cursor.
- Local schema migration IDs are immutable once released; add a new migration instead of editing a migration already applied to a user's database.

## Runtime acceptance test

On the target Windows machine, run `npm install`, then `npm run check`, then start Electron with a valid development URL/token. Confirm the window opens, displays a clear status if the API is unavailable or returns 401, and imports at least one real product created through the API. Capture the exact terminal error and visible window state if any step fails. Do not mark the runtime validated based only on static checks.

## Milestones

1. Walking skeleton: app window, SQLite initialization/migrations, real authenticated pull, local product upsert, product count, visible sync outcome.
2. Durable outbox and push: transactionally record local changes, idempotent push, remove/acknowledge only confirmed items, pending count, per-entity pull cursors and persistence.
3. Single-screen cashier: barcode/search, cart, payment, sale commit to local DB + outbox.
4. Cash session and receipts: opening/closing/reconciliation, 80 mm USB printer adapter, then supervised field trial with two physical PCs and a deliberately interrupted network.
