# Eden Devs Corp: Sync Engine & Eden Gestion

[![CI](https://github.com/tshibandachris/sync-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/tshibandachris/sync-engine/actions/workflows/ci.yml)

An offline-first sync backend and Windows point-of-sale client for shops and small businesses in Sub-Saharan Africa, where power and internet cuts are routine.

**Eden Gestion** is a business management system made of a multi-tenant API (**Sync Engine**) and an offline-first Windows cashier client (**Eden Gestion Desktop**). The cashier keeps working during outages, and operations sync when the connection returns.

## Highlights

- **Multi-tenant isolation** with PostgreSQL Row-Level Security (RLS), covered by PostgreSQL integration tests.
- **Accounting integrity.** Sales, sale lines and stock movements are protected by database-level controls. A sale is not edited or deleted; corrections use a mirror void sale.
- **Durable offline queue.** The client keeps pending operations in a local SQLite outbox and retries them with idempotency keys.
- **Device identity and approval.** Each terminal enrolls with an ES256 cryptographic proof, remains pending until an administrator decision, and can later be revoked. Protected POS synchronization routes verify the terminal identity, approval state and proof of possession.
- **Least-privilege database access.** The application, device enrollment and device administration use separate PostgreSQL identities and capability roles.
- **Automated validation.** Backend and Electron tests include PostgreSQL integration coverage and client-side failure simulations. The field-simulation suite is run separately with `npm run test:field`.
- **CI on pull requests** and versioned PostgreSQL SQL migrations (001–038).

## Architecture

- **Backend (Sync Engine).** NestJS API, PostgreSQL, Drizzle ORM, RLS policies, incremental push/pull synchronization, and S3-compatible attachment storage through SeaweedFS.
- **Client (Eden Gestion Desktop).** Electron app for Windows x64, local SQLite database, local product catalog and a durable outbox.

## Terminal lifecycle

1. **Enrollment.** On first run, the client generates its device key material, stores it through Electron secure storage, and sends an enrollment request with a cryptographic proof.
2. **Pending.** A newly enrolled terminal cannot use protected POS synchronization routes until approved.
3. **Approval or rejection.** An authorized administrator approves or rejects the terminal through the administration API. Decisions are tenant-scoped and audited.
4. **Synchronization.** Approved terminals push and pull with their identity and a fresh proof of possession.
5. **Revocation.** An authorized administrator can revoke an approved terminal. Its active credential is revoked and protected synchronization access is denied.

The administration API is available. A dedicated graphical interface for administrators is not available yet. See [the device administration contract](docs/device-admin-approval.md).

## Local setup

### Requirements

- Node.js 20+ for the backend.
- Docker and Docker Compose for local services.
- Windows x64 and Node.js 22 for the Electron client.
- Visual Studio Build Tools with C++ components may be needed for native modules.

### 1. Backend

At the repository root, create a local, untracked environment file from `.env.example`, replace the placeholder secrets, then start the local services:

```powershell
Copy-Item .env.example .env
docker compose up -d
```

For production, use only a prepared and reviewed secrets configuration:

```powershell
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

The API listens on port 3000 with the default local configuration. The application, enrollment and device-administration database URLs must use their respective dedicated credentials. Never commit tokens, keys, passwords or environment files containing secrets.

### 2. Desktop client

```powershell
cd electron-app
npm ci
npm run check
npm test
npm run test:field
npm start
```

The client needs a reachable API URL and an enrolled, approved terminal for protected POS synchronization. In unpackaged development mode, `EDEN_SYNC_TOKEN` can bootstrap a local token. Packaged builds do not use this variable as an authentication mechanism.

## Repository structure

- `src/`: NestJS API, business services, sync, security and observability.
- `migrations/`: versioned SQL migrations for PostgreSQL (001–038).
- `electron-app/`: Windows client (Electron, SQLite, UI, IPC security, sync).
- `test/`: backend and integration tests.
- `electron-app/test/`: desktop client tests and field simulations.
- `docs/`: technical contracts, architecture and validation plans.
- `.github/workflows/`: server CI, POS migration smoke test, Electron CI and Windows installer build.

## Checks

From the repository root:

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

From `electron-app/`:

```powershell
npm ci
npm run check
npm test
npm run test:field
```

Passing CI does not replace installation, backup/restore, synchronization and business validation tests on a target Windows machine.

## Project status

The backend and desktop client already contain significant working components. Automated checks passing on a commit do not, by themselves, establish production or field readiness. Before commercial use, the full cashier workflow, activation and approval lifecycle, installation and update on a clean Windows machine, backup and restore, and end-to-end synchronization scenarios still need to be verified in the target environment.

## Documentation

- [Device administration and approval](docs/device-admin-approval.md)
- [Device enrollment database isolation](docs/device-enrollment-db-isolation.md)
- [Electron architecture](docs/electron-architecture.md)
- [Electron packaging](docs/electron-packaging.md)
- [POS sales push contract](docs/pos-sales-push-contract.md)
- `HANDOFF.md` and `CONTRIBUTING.md`

## License

Copyright (c) Eden Devs Corp. All rights reserved. The source is public for review and evaluation. No permission is granted to use, copy, modify or redistribute it without written agreement.

---

Eden Devs Corp, Kinshasa, DR Congo. https://edendevscorp.com
