# Eden Gestion E2E runner

## Purpose

This workflow provisions an ephemeral GitHub-hosted Linux runner to verify that the independent test components required by the Eden Gestion E2E suite are reachable:

- PostgreSQL 16 through Testcontainers, with the repository migration runner;
- a local OIDC discovery/JWKS server started by the API E2E fixture;
- the real NestJS API E2E tests;
- the Electron SQLite/outbox/field-failure tests;
- the actual Electron renderer launched under Xvfb and observed through its loopback-only Chromium DevTools endpoint.

Workflow: `.github/workflows/eden-gestion-e2e-environment.yml`.

## Run

The workflow runs on pull requests targeting `validation/full-device-approval-signed-sync-v4` when relevant source paths change. It can also be started manually with GitHub Actions `workflow_dispatch`.

No persistent database, cloud IdP, Render service, production credential, or production migration is used. Testcontainers and the OIDC provider are created locally for the job and torn down by the test fixture. Electron uses a temporary user-data directory that is removed after the window smoke test.

## Evidence boundary

A green run proves that the API/PostgreSQL/OIDC test fixture runs, the Electron local test suites run, and the real Electron renderer can start in a virtual display.

It does **not** yet prove a single integrated Electron-to-API business flow, nor does it mark any of the 13 official acceptance scenarios PASS. Those scenarios require dedicated end-to-end orchestration and per-scenario evidence (client state, HTTP exchange, database state, and logs) on one commit SHA.

The workflow is an environment-access gate, not a field-readiness or release gate.
