# Eden Gestion — architecture Electron (V1)

Status: decisions for the walking skeleton; this document evolves with reviewed PRs.

## Product boundary

The Electron client is a separate application in `electron-app/`, kept beside the NestJS sync engine. It must use the real API contract and real data. No mock data in the runtime path.

## Decisions

1. **Identity and authentication:** distinguish installation identity from cashier identity. The device JWT identifies the installation and tenant; each sale carries the acting `staff_id`. The sales-push handler must verify the staff belongs to the JWT tenant before inserting the sale.
2. **Offline PIN:** a local PIN unlocks the cashier UI but is not server-side identity proof. Store only a password hash locally.
3. **Device enrollment and token lifecycle:** production device JWTs are loaded only from `DeviceTokenStore`, which uses Electron `safeStorage` and stores encrypted bytes in `%APPDATA%/EdenGestion/device-token.enc`. The packaged application never reads `EDEN_SYNC_TOKEN` from the environment. Development builds may bootstrap a missing token from that variable once, then immediately encrypt and persist it. If OS-backed encryption is unavailable, the selected backend is plaintext-only/unknown, the token cannot be decrypted, or no production token exists, authentication fails closed and synchronization is disabled; there is no plaintext fallback. The dedicated enrollment/refresh flow remains a separate release requirement.
4. **SQLite:** `better-sqlite3`, one database per Windows installation at `%APPDATA%/EdenGestion/data.db`. Existing local databases are preserved.
5. **Transport:** direct HTTP(S) to NestJS. No proxy or WebSocket in V1.
6. **Connectivity and visible status:** derive status from actual API requests; retain local data on failure and retry with bounded backoff. A failed pull must never look like a successful sync.
7. **Receipt printer:** USB ESC/POS thermal printer, 80 mm first. Validate target printers on Windows before promising model compatibility.
8. **Local schema:** numbered, forward-only SQLite migrations. Never delete the local database to upgrade it.
9. **Native module build:** `better-sqlite3` must be rebuilt for Electron's Node ABI after dependency installation.

## Pull cursor contract

The backend exposes one global `timestamp` cursor across the entity feed. The Electron client commits each returned page in one SQLite transaction, persists operational records and the sync cache, and updates the cursor in that same transaction only after the full page validates and persists. Never advance a cursor for changes that were not durably persisted.

## Security and operations

- Never commit a real token or secret.
- Production device tokens must only be read through `DeviceTokenStore`; never read a plaintext token file or `process.env.EDEN_SYNC_TOKEN` in a packaged build.
- Electron `safeStorage` must report encryption available and must not select the `basic_text` or `unknown` backend. Failure to meet this requirement blocks authenticated sync.
- Token persistence uses encrypted bytes, a temporary file plus atomic rename, and restrictive file permissions where supported. Corrupt ciphertext is a hard authentication error; it is never interpreted as plaintext.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and a narrow preload API.
- Validate response shapes and enforce HTTPS outside explicitly local development.
- A failed pull must not erase local records or advance any cursor.

## Runtime acceptance test

On the target Windows machine, run `npm install`, then `npm run check`, then test with an enrolled encrypted device token. Confirm the app refuses to sync if safeStorage is unavailable or the token file is corrupt, while local data remains intact. Do not mark runtime validated based only on static checks.

## Milestones

1. Walking skeleton: app window, SQLite initialization/migrations, real authenticated pull.
2. Durable outbox and push: transactionally record local changes, idempotent push, remove/acknowledge only confirmed items.
3. Single-screen cashier: barcode/search, cart, payment, sale commit to local DB + outbox.
4. Cash session and receipts: opening/closing/reconciliation and supervised field trial.
