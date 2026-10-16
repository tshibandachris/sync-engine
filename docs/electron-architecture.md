# Eden Gestion — architecture Electron (V1)

Status: decisions for the walking skeleton; this document evolves with reviewed PRs.

## Product boundary

The Electron client is a separate application in `electron-app/`, kept beside the NestJS sync engine. It must use the real API contract and real data. No mock data in the runtime path.

## Decisions

1. **Offline authentication:** local PIN unlocks the cashier UI. The PIN hash is local and is provisioned through a dedicated, authenticated staff-enrolment flow; it must not be copied from the normal sync feed. Use an installation/device JWT issued by the backend and refresh it when online. Do not treat a shared tenant token as proof of cashier identity. The server must validate that every submitted `staff_id` belongs to the authenticated tenant and record the device/agent identity. Offline PIN is a local UI gate, not server-side identity proof.
2. **SQLite:** `better-sqlite3`, one database per Windows installation at `%APPDATA%/EdenGestion/data.db`. Multiple Windows users on one PC do not automatically share the same roaming AppData path; sharing one database across Windows accounts is not a V1 guarantee.
3. **Transport:** direct HTTP(S) to NestJS. No proxy or WebSocket in V1. Poll every 30 seconds once the initial pull and durable local storage are implemented.
4. **Connectivity:** do not trust `navigator.onLine`. Derive status from the last real request; on failure retain local data and retry with bounded backoff.
5. **Receipt printer:** USB ESC/POS thermal printer, 80 mm first. Keep printing behind an adapter so a later driver/library choice does not leak into sale logic. Validate target printers on Windows before promising model compatibility.
6. **Local schema:** numbered, forward-only local migrations recorded in SQLite (schema_migrations). Never delete the local database to upgrade it. Back up before migrations that may rewrite data.

## Walking skeleton scope

- Electron main process opens a minimal window.
- Preload exposes a small, explicit IPC surface; renderer has no Node integration.
- Startup creates the SQLite tables, then makes an authenticated `POST /sync/pull` with `{ "last_pulled_at": 0 }`.
- The current backend contract is `POST /sync/pull`, not GET `/sync/pull?since=0`. Response cursor is `timestamp`; products arrive under `changes.products.created`, `updated`, and `deleted`.
- Persist product changes with parameterized SQLite statements and update the cursor only after the response is committed locally.
- Display the count of locally stored products. No sale UI, PIN flow, outbox push, or printing in this milestone.

## Security and operations

- Configure the API base URL and device token outside source control for this initial development skeleton. Never commit a real token or secret. Packaged builds must move token storage to OS-backed secure storage and provide an enrollment/refresh flow.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and a narrow preload API.
- Validate response shapes and enforce HTTPS outside explicitly local development.
- A failed pull must not erase local records or advance the cursor.
- Local schema migration IDs are immutable once released; add a new migration instead of editing a migration already applied to a user's database.

## Milestones

1. Walking skeleton: app window, SQLite initialization/migrations, real authenticated pull, local product upsert, product count.
2. Durable outbox and push: transactionally record local changes, idempotent push, remove/acknowledge only confirmed items, pending count.
3. Single-screen cashier: barcode/search, cart, payment, sale commit to local DB + outbox.
4. Cash session and receipts: opening/closing/reconciliation, 80 mm USB printer adapter, then supervised field trial with two physical PCs and a deliberately interrupted network.
